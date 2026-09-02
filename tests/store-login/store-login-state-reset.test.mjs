import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';
import {
  applyReset,
  nodeFileSystem,
  parseArguments,
  planReset,
  resetStoreLoginState,
  validateInputsForReset,
} from '../../scripts/reset_full_managed_store_login_state.mjs';

const SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/reset_full_managed_store_login_state.mjs', import.meta.url),
);
const PLANNED_UPDATED_AT = '2026-09-03T02:03:04.567Z';
const BACKUP_CLOCK = '2026-09-03T03:04:05.678Z';
const INCIDENT_ERROR = 'store identity was not visible after login';
const RESET_ERROR = 'SESSION_RELOGIN_REQUIRED';
const SECRET_MARKER = 'SECRET-COOKIE-MARKER-DO-NOT-PRINT';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildState({ active = null } = {}) {
  const stores = {};
  FULL_MANAGED_STORE_CODES.forEach((storeCode, index) => {
    const isAttention = index === FULL_MANAGED_STORE_CODES.length - 1;
    stores[storeCode] = {
      status: isAttention ? 'needs_attention' : 'completed',
      completedAt: isAttention ? null : '2026-08-01T00:00:00.000Z',
      verified: !isAttention,
      lastError: isAttention ? INCIDENT_ERROR : null,
    };
  });
  return { active, stores, updatedAt: '2026-08-31T00:00:00.000Z', version: 1 };
}

function buildRenewalReport({
  activeStoreCodes = [],
  explicitActiveRecoveryFields = false,
} = {}) {
  const active = new Set(activeStoreCodes);
  const results = FULL_MANAGED_STORE_CODES.map((storeCode) => {
    const isActive = active.has(storeCode);
    const base = {
      storeCode,
      state: isActive ? 'ACTIVE' : 'EXPIRED',
      renewed: isActive,
      transport: 'SESSION_HTTP',
    };
    if (isActive) {
      return explicitActiveRecoveryFields
        ? { ...base, recoveryQueued: false, errorCode: null }
        : base;
    }
    return {
      ...base,
      recoveryQueued: true,
      errorCode: 'HOME_AUTH_EXPIRED',
    };
  });
  return {
    version: 2,
    generatedAt: '2026-08-31T01:00:00.000Z',
    completedProfileCount: FULL_MANAGED_STORE_CODES.length,
    activeCount: results.filter((item) => item.state === 'ACTIVE').length,
    recoveryQueuedCount: results.filter((item) => item.recoveryQueued).length,
    results,
  };
}

function buildRecoveryQueue(storeCodes = FULL_MANAGED_STORE_CODES) {
  return {
    version: 1,
    generatedAt: '2026-08-31T01:00:00.000Z',
    reason: 'HTTP_SESSION_VALIDATION_FAILED',
    stores: [...storeCodes],
  };
}

async function writeInputs(dir, { state, renewalReport, recoveryQueue }) {
  const stateFile = path.join(dir, 'state.json');
  const renewalReportFile = path.join(dir, 'renewal-report.json');
  const recoveryQueueFile = path.join(dir, 'session-recovery.json');
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(stateFile, 0o600);
  await fs.writeFile(renewalReportFile, JSON.stringify(renewalReport, null, 2) + '\n');
  await fs.writeFile(recoveryQueueFile, JSON.stringify(recoveryQueue, null, 2) + '\n');
  return { stateFile, renewalReportFile, recoveryQueueFile };
}

async function snapshotDirectory(dir) {
  const entries = (await fs.readdir(dir)).sort();
  const files = {};
  for (const entry of entries) {
    const file = path.join(dir, entry);
    const stat = await fs.stat(file);
    files[entry] = {
      sha256: sha256(await fs.readFile(file)),
      mode: stat.mode & 0o777,
    };
  }
  return { entries, files };
}

async function withTempInputs(callback, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'store-login-reset-'));
  try {
    const state = overrides.state ?? buildState();
    const renewalReport = overrides.renewalReport ?? buildRenewalReport();
    const recoveryQueue = overrides.recoveryQueue ?? buildRecoveryQueue();
    const files = await writeInputs(dir, { state, renewalReport, recoveryQueue });
    return await callback({ dir, files, state, renewalReport, recoveryQueue });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function makePlan(files, plannedUpdatedAt = PLANNED_UPDATED_AT) {
  return planReset({ ...files, plannedUpdatedAt });
}

function applyOptions(files, plan, extra = {}) {
  return {
    ...files,
    plannedUpdatedAt: plan.plannedUpdatedAt,
    expectedPlannedStateSha256: plan.plannedStateSha256,
    expectedSha256: plan.inputSha256,
    ...extra,
  };
}

function cliPathArguments(files) {
  return [
    '--state-file', files.stateFile,
    '--renewal-report-file', files.renewalReportFile,
    '--recovery-queue-file', files.recoveryQueueFile,
  ];
}

function cliApplyArguments(files, plan) {
  return [
    '--apply',
    ...cliPathArguments(files),
    '--planned-updated-at', plan.plannedUpdatedAt,
    '--expected-planned-state-sha256', plan.plannedStateSha256,
    '--expected-state-sha256', plan.inputSha256.state,
    '--expected-renewal-report-sha256', plan.inputSha256.renewalReport,
    '--expected-recovery-queue-sha256', plan.inputSha256.recoveryQueue,
  ];
}

test('incident shape resets 24 completed + 1 needs_attention with 25 EXPIRED to 25 pending', () => {
  const { nextState, plan } = resetStoreLoginState({
    state: buildState(),
    renewalReport: buildRenewalReport(),
    recoveryQueue: buildRecoveryQueue(),
    plannedUpdatedAt: PLANNED_UPDATED_AT,
  });
  assert.equal(plan.storeCodes.length, 25);
  assert.equal(plan.unchangedStoreCodes.length, 0);
  assert.deepEqual(plan.storeCodes, [...FULL_MANAGED_STORE_CODES]);
  for (const storeCode of FULL_MANAGED_STORE_CODES) {
    assert.deepEqual(nextState.stores[storeCode], {
      status: 'pending',
      completedAt: null,
      verified: false,
      lastError: RESET_ERROR,
    });
  }
  assert.equal(nextState.active, null);
  assert.equal(nextState.updatedAt, PLANNED_UPDATED_AT);
  assert.equal(nextState.version, 1);
});

test('real mixed ACTIVE/EXPIRED producer shape preserves ACTIVE and resets only failures', () => {
  const preserved = FULL_MANAGED_STORE_CODES.slice(0, 3);
  const queued = FULL_MANAGED_STORE_CODES.slice(3);
  const state = buildState();
  const renewalReport = buildRenewalReport({ activeStoreCodes: preserved });
  for (const item of renewalReport.results.filter((result) => result.state === 'ACTIVE')) {
    assert.deepEqual(Object.keys(item), ['storeCode', 'state', 'renewed', 'transport']);
  }
  const { nextState, plan } = resetStoreLoginState({
    state,
    renewalReport,
    recoveryQueue: buildRecoveryQueue(queued),
    plannedUpdatedAt: PLANNED_UPDATED_AT,
  });
  assert.deepEqual(plan.unchangedStoreCodes, preserved);
  assert.equal(plan.storeCodes.length, 22);
  for (const storeCode of preserved) {
    assert.deepEqual(nextState.stores[storeCode], state.stores[storeCode]);
  }
  for (const storeCode of queued) {
    assert.equal(nextState.stores[storeCode].status, 'pending');
    assert.equal(nextState.stores[storeCode].lastError, RESET_ERROR);
  }
});

test('ACTIVE producer rows also accept explicit recoveryQueued false and errorCode null', () => {
  const activeStoreCodes = FULL_MANAGED_STORE_CODES.slice(0, 2);
  const renewalReport = buildRenewalReport({
    activeStoreCodes,
    explicitActiveRecoveryFields: true,
  });
  const { nextState, plan } = resetStoreLoginState({
    state: buildState(),
    renewalReport,
    recoveryQueue: buildRecoveryQueue(FULL_MANAGED_STORE_CODES.slice(2)),
    plannedUpdatedAt: PLANNED_UPDATED_AT,
  });
  assert.deepEqual(plan.unchangedStoreCodes, activeStoreCodes);
  assert.equal(plan.storeCodes.length, 23);
  for (const storeCode of activeStoreCodes) {
    assert.equal(nextState.stores[storeCode].status, 'completed');
  }
});

test('ACTIVE rows fail closed when queued or carrying a non-empty errorCode', () => {
  const activeStoreCode = FULL_MANAGED_STORE_CODES[0];
  const queuedActiveReport = buildRenewalReport({ activeStoreCodes: [activeStoreCode] });
  queuedActiveReport.results[0].recoveryQueued = true;
  assert.throws(
    () => validateInputsForReset({
      state: buildState(),
      renewalReport: queuedActiveReport,
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'ACTIVE_RENEWAL_RESULT_RECOVERY_QUEUED',
  );

  const erroredActiveReport = buildRenewalReport({ activeStoreCodes: [activeStoreCode] });
  erroredActiveReport.results[0].errorCode = 'HOME_AUTH_EXPIRED';
  assert.throws(
    () => validateInputsForReset({
      state: buildState(),
      renewalReport: erroredActiveReport,
      recoveryQueue: buildRecoveryQueue(FULL_MANAGED_STORE_CODES.slice(1)),
    }),
    (error) => error.message === 'ACTIVE_RENEWAL_RESULT_ERROR_CODE_PRESENT',
  );
});

test('non-ACTIVE rows require recoveryQueued true and a non-empty safe errorCode', () => {
  const missingRecoveryFlag = buildRenewalReport();
  delete missingRecoveryFlag.results[0].recoveryQueued;
  assert.throws(
    () => validateInputsForReset({
      state: buildState(),
      renewalReport: missingRecoveryFlag,
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'RENEWAL_RESULT_FIELD_MISSING',
  );

  const missingErrorCode = buildRenewalReport();
  delete missingErrorCode.results[0].errorCode;
  assert.throws(
    () => validateInputsForReset({
      state: buildState(),
      renewalReport: missingErrorCode,
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'RENEWAL_RESULT_FIELD_MISSING',
  );

  const falseRecoveryFlag = buildRenewalReport();
  falseRecoveryFlag.results[0].recoveryQueued = false;
  assert.throws(
    () => validateInputsForReset({
      state: buildState(),
      renewalReport: falseRecoveryFlag,
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'NON_ACTIVE_RENEWAL_RESULT_NOT_QUEUED',
  );

  for (const invalidErrorCode of ['', null, { unsafe: true }, 'lowercase-error']) {
    const invalidErrorReport = buildRenewalReport();
    invalidErrorReport.results[0].errorCode = invalidErrorCode;
    assert.throws(
      () => validateInputsForReset({
        state: buildState(),
        renewalReport: invalidErrorReport,
        recoveryQueue: buildRecoveryQueue(),
      }),
      (error) => error.message === 'NON_ACTIVE_RENEWAL_RESULT_ERROR_CODE_INVALID',
    );
  }
});

test('renewal result rows reject unknown fields for both ACTIVE and non-ACTIVE shapes', () => {
  for (const activeStoreCodes of [[], [FULL_MANAGED_STORE_CODES[0]]]) {
    const renewalReport = buildRenewalReport({ activeStoreCodes });
    renewalReport.results[0].unexpected = true;
    assert.throws(
      () => validateInputsForReset({
        state: buildState(),
        renewalReport,
        recoveryQueue: buildRecoveryQueue(
          activeStoreCodes.length === 0
            ? FULL_MANAGED_STORE_CODES
            : FULL_MANAGED_STORE_CODES.slice(1),
        ),
      }),
      (error) => error.message === 'RENEWAL_RESULT_FIELD_UNKNOWN',
    );
  }
});

test('dry-run is zero-write and a supplied plannedUpdatedAt yields immutable plan bytes', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const before = await snapshotDirectory(dir);
    const first = await makePlan(files);
    const second = await makePlan(files);
    const after = await snapshotDirectory(dir);
    assert.deepEqual(after, before);
    assert.equal(first.plannedUpdatedAt, PLANNED_UPDATED_AT);
    assert.equal(first.plan.storeCodes.length, 25);
    assert.equal(first.plannedStateSha256, sha256(first.plannedStateJson));
    assert.equal(second.plannedStateJson, first.plannedStateJson);
    assert.equal(second.plannedStateSha256, first.plannedStateSha256);
  });
});

test('default CLI dry-run generates reusable exact-plan fields and no sensitive input values', async () => {
  await withTempInputs(
    async ({ files, state }) => {
      const run = spawnSync(
        process.execPath,
        [SCRIPT_PATH, ...cliPathArguments(files)],
        { encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stderr || run.stdout);
      const payload = JSON.parse(run.stdout);
      assert.deepEqual(Object.keys(payload).sort(), [
        'inputSha256',
        'mode',
        'ok',
        'plannedStateSha256',
        'plannedUpdatedAt',
        'preservedStoreCount',
        'resettableStoreCount',
        'storeCodes',
        'unchangedStoreCodes',
      ]);
      assert.equal(payload.mode, 'dry-run');
      assert.equal(payload.ok, true);
      assert.equal(new Date(payload.plannedUpdatedAt).toISOString(), payload.plannedUpdatedAt);
      assert.equal(payload.resettableStoreCount, 25);
      assert.equal(payload.storeCodes.length, 25);
      assert.match(payload.inputSha256.state, /^[0-9a-f]{64}$/);
      assert.match(payload.plannedStateSha256, /^[0-9a-f]{64}$/);
      assert.ok(!run.stdout.includes(SECRET_MARKER));
      assert.ok(!run.stdout.includes(files.stateFile));
      assert.ok(JSON.stringify(state).includes(SECRET_MARKER));
    },
    {
      state: (() => {
        const value = buildState();
        value.stores[FULL_MANAGED_STORE_CODES[0]].lastError = 'leaked ' + SECRET_MARKER;
        return value;
      })(),
    },
  );
});

test('apply preserves state owner/mode, records chown/chmod, and creates an exact 0600 backup', async () => {
  await withTempInputs(async ({ dir, files, state }) => {
    const originalBytes = await fs.readFile(files.stateFile);
    const originalStat = await fs.stat(files.stateFile);
    const plan = await makePlan(files);
    const chownCalls = [];
    const chmodCalls = [];
    const fileSystem = {
      ...nodeFileSystem,
      chown: async (file, uid, gid) => {
        chownCalls.push({ file, uid, gid });
        await nodeFileSystem.chown(file, uid, gid);
      },
      chmod: async (file, mode) => {
        chmodCalls.push({ file, mode });
        await nodeFileSystem.chmod(file, mode);
      },
    };
    const result = await applyReset(applyOptions(files, plan, {
      fileSystem,
      now: () => new Date(BACKUP_CLOCK),
      randomId: (() => {
        const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
        return () => ids.shift();
      })(),
    }));
    assert.equal(result.writtenStateSha256, plan.plannedStateSha256);
    assert.equal(result.plannedUpdatedAt, PLANNED_UPDATED_AT);
    const written = JSON.parse(await fs.readFile(files.stateFile, 'utf8'));
    assert.equal(written.updatedAt, PLANNED_UPDATED_AT);
    assert.equal(written.stores[FULL_MANAGED_STORE_CODES[0]].status, 'pending');
    assert.equal(written.stores[FULL_MANAGED_STORE_CODES[0]].lastError, RESET_ERROR);
    assert.equal(written.version, state.version);

    const writtenStat = await fs.stat(files.stateFile);
    assert.equal(writtenStat.uid, originalStat.uid);
    assert.equal(writtenStat.gid, originalStat.gid);
    assert.equal(writtenStat.mode & 0o777, originalStat.mode & 0o777);
    assert.ok(chownCalls.length >= 2, 'backup and replacement temp must both be chowned');
    assert.ok(chownCalls.every((call) =>
      call.uid === originalStat.uid && call.gid === originalStat.gid
    ));
    assert.ok(chmodCalls.some((call) => call.mode === 0o600));
    assert.ok(chmodCalls.some((call) => call.mode === (originalStat.mode & 0o777)));

    assert.equal(path.basename(result.backupFile), result.backupBasename);
    const backupRaw = await fs.readFile(path.join(dir, result.backupBasename));
    assert.deepEqual(backupRaw, originalBytes);
    if (process.platform !== 'win32') {
      const backupStat = await fs.stat(result.backupFile);
      assert.equal(backupStat.mode & 0o777, 0o600);
      assert.equal(backupStat.uid, originalStat.uid);
      assert.equal(backupStat.gid, originalStat.gid);
    }
    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

test('apply rejects changed plan time or expected plan hash before writing', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const plan = await makePlan(files);
    const before = await snapshotDirectory(dir);
    await assert.rejects(
      applyReset({
        ...applyOptions(files, plan),
        plannedUpdatedAt: '2026-09-03T02:03:05.567Z',
      }),
      (error) => error.message === 'PLANNED_STATE_SHA256_MISMATCH',
    );
    assert.deepEqual(await snapshotDirectory(dir), before);
    await assert.rejects(
      applyReset({
        ...applyOptions(files, plan),
        expectedPlannedStateSha256: sha256('different-plan'),
      }),
      (error) => error.message === 'PLANNED_STATE_SHA256_MISMATCH',
    );
    assert.deepEqual(await snapshotDirectory(dir), before);
    await assert.rejects(
      applyReset({
        ...applyOptions(files, plan),
        expectedPlannedStateSha256: null,
      }),
      (error) => error.message === 'EXPECTED_PLANNED_STATE_SHA256_REQUIRED',
    );
    assert.deepEqual(await snapshotDirectory(dir), before);
  });
});

test('apply rejects mismatched or missing input hashes before writing', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const plan = await makePlan(files);
    const before = await snapshotDirectory(dir);
    await assert.rejects(
      applyReset({
        ...applyOptions(files, plan),
        expectedSha256: { ...plan.inputSha256, state: sha256('not-state') },
      }),
      (error) => error.message === 'INPUT_SHA256_DRIFT',
    );
    assert.deepEqual(await snapshotDirectory(dir), before);
    await assert.rejects(
      applyReset({
        ...applyOptions(files, plan),
        expectedSha256: {},
      }),
      (error) => error.message === 'EXPECTED_SHA256_REQUIRED',
    );
    assert.deepEqual(await snapshotDirectory(dir), before);
  });
});

test('active session or invalid active field fails closed', () => {
  const activeState = buildState({ active: { storeCode: FULL_MANAGED_STORE_CODES[0] } });
  assert.throws(
    () => resetStoreLoginState({
      state: activeState,
      renewalReport: buildRenewalReport(),
      recoveryQueue: buildRecoveryQueue(),
      plannedUpdatedAt: PLANNED_UPDATED_AT,
    }),
    (error) => error.message === 'ACTIVE_SESSION_PRESENT',
  );
  assert.throws(
    () => validateInputsForReset({
      state: buildState({ active: 'stale-session' }),
      renewalReport: buildRenewalReport(),
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'ACTIVE_FIELD_INVALID',
  );
});

test('state validation rejects wrong counts, non-canonical codes and incomplete entries', () => {
  const shortState = buildState();
  delete shortState.stores[FULL_MANAGED_STORE_CODES[0]];
  assert.throws(
    () => validateInputsForReset({
      state: shortState,
      renewalReport: buildRenewalReport(),
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'STATE_STORE_COUNT_INVALID',
  );
  const rogueState = buildState();
  delete rogueState.stores[FULL_MANAGED_STORE_CODES[0]];
  rogueState.stores.XX9999 = rogueState.stores[FULL_MANAGED_STORE_CODES[1]];
  assert.throws(
    () => validateInputsForReset({
      state: rogueState,
      renewalReport: buildRenewalReport(),
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'STATE_STORE_NOT_CANONICAL',
  );
  const missingFieldState = buildState();
  delete missingFieldState.stores[FULL_MANAGED_STORE_CODES[0]].completedAt;
  assert.throws(
    () => validateInputsForReset({
      state: missingFieldState,
      renewalReport: buildRenewalReport(),
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'STATE_STORE_FIELD_MISSING',
  );
});

test('renewal validation rejects wrong result count, duplicate stores and completedProfileCount drift', () => {
  const base = { state: buildState(), recoveryQueue: buildRecoveryQueue() };
  const shortReport = buildRenewalReport();
  shortReport.results.pop();
  shortReport.recoveryQueuedCount -= 1;
  assert.throws(
    () => validateInputsForReset({ ...base, renewalReport: shortReport }),
    (error) => error.message === 'RENEWAL_RESULTS_COUNT_INVALID',
  );
  const duplicateReport = buildRenewalReport();
  duplicateReport.results[1] = { ...duplicateReport.results[0] };
  assert.throws(
    () => validateInputsForReset({ ...base, renewalReport: duplicateReport }),
    (error) => error.message === 'RENEWAL_RESULT_DUPLICATE_STORE',
  );
  const badCompletedCount = buildRenewalReport();
  badCompletedCount.completedProfileCount = 24;
  assert.throws(
    () => validateInputsForReset({ ...base, renewalReport: badCompletedCount }),
    (error) => error.message === 'RENEWAL_COMPLETED_PROFILE_COUNT_INVALID',
  );
});

test('recovery queue validation rejects structural defects, duplicates and report-set mismatch', () => {
  const base = { state: buildState(), renewalReport: buildRenewalReport() };
  const missingKey = buildRecoveryQueue();
  delete missingKey.stores;
  assert.throws(
    () => validateInputsForReset({ ...base, recoveryQueue: missingKey }),
    (error) => error.message === 'RECOVERY_QUEUE_TOP_KEY_MISSING',
  );
  const duplicated = buildRecoveryQueue([
    ...FULL_MANAGED_STORE_CODES.slice(0, 24),
    FULL_MANAGED_STORE_CODES[0],
  ]);
  assert.throws(
    () => validateInputsForReset({ ...base, recoveryQueue: duplicated }),
    (error) => error.message === 'RECOVERY_QUEUE_DUPLICATE_STORE',
  );
  const mismatched = buildRecoveryQueue(FULL_MANAGED_STORE_CODES.slice(1));
  assert.throws(
    () => validateInputsForReset({ ...base, recoveryQueue: mismatched }),
    (error) => error.message === 'RECOVERY_QUEUE_REPORT_MISMATCH',
  );
  const countMismatchReport = buildRenewalReport();
  countMismatchReport.recoveryQueuedCount = 24;
  assert.throws(
    () => validateInputsForReset({
      state: buildState(),
      renewalReport: countMismatchReport,
      recoveryQueue: buildRecoveryQueue(),
    }),
    (error) => error.message === 'RENEWAL_REPORT_RECOVERY_COUNT_MISMATCH',
  );
});

test('backup creation is exclusive and never overwrites an existing backup', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const plan = await makePlan(files);
    const backupBasename = 'state.json.2026-09-03T03-04-05-678Z.aaaaaaaaaaaaaaaa.bak';
    const existingBackup = path.join(dir, backupBasename);
    const sentinel = Buffer.from('existing-backup-must-survive');
    await fs.writeFile(existingBackup, sentinel, { mode: 0o600 });
    const stateBefore = await fs.readFile(files.stateFile);
    await assert.rejects(
      applyReset(applyOptions(files, plan, {
        now: () => new Date(BACKUP_CLOCK),
        randomId: () => 'aaaaaaaaaaaaaaaa',
      })),
      (error) => error.message === 'BACKUP_FILE_ALREADY_EXISTS',
    );
    assert.deepEqual(await fs.readFile(existingBackup), sentinel);
    assert.deepEqual(await fs.readFile(files.stateFile), stateBefore);
    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });
});

test('rename failure cleans exclusive temp and backup while leaving state untouched', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const plan = await makePlan(files);
    const before = await snapshotDirectory(dir);
    const fileSystem = {
      ...nodeFileSystem,
      rename: async () => {
        const error = new Error('simulated rename failure');
        error.code = 'EIO';
        throw error;
      },
    };
    await assert.rejects(
      applyReset(applyOptions(files, plan, {
        fileSystem,
        randomId: (() => {
          const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
          return () => ids.shift();
        })(),
      })),
      (error) => error.message === 'STATE_ATOMIC_RENAME_FAILED',
    );
    assert.deepEqual(await snapshotDirectory(dir), before);
  });
});

test('final pre-rename recheck rejects live input drift and cleans created artifacts', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const plan = await makePlan(files);
    const stateBefore = await fs.readFile(files.stateFile);
    let queueReadCount = 0;
    const fileSystem = {
      ...nodeFileSystem,
      readFile: async (file, ...args) => {
        if (file === files.recoveryQueueFile) {
          queueReadCount += 1;
          if (queueReadCount === 2) await fs.appendFile(file, ' ');
        }
        return nodeFileSystem.readFile(file, ...args);
      },
    };
    await assert.rejects(
      applyReset(applyOptions(files, plan, {
        fileSystem,
        randomId: (() => {
          const ids = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'];
          return () => ids.shift();
        })(),
      })),
      (error) => error.message === 'INPUT_SHA256_DRIFT',
    );
    assert.deepEqual(await fs.readFile(files.stateFile), stateBefore);
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries.filter((name) => name.endsWith('.bak')), []);
    assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), []);
  });
});

test('post-write hash mismatch restores exact original state bytes, owner and mode', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const plan = await makePlan(files);
    const originalBytes = await fs.readFile(files.stateFile);
    const originalStat = await fs.stat(files.stateFile);
    let renameCount = 0;
    const fileSystem = {
      ...nodeFileSystem,
      rename: async (from, to) => {
        await nodeFileSystem.rename(from, to);
        renameCount += 1;
        if (renameCount === 1) await fs.appendFile(to, '\ncorrupted-after-rename');
      },
    };
    await assert.rejects(
      applyReset(applyOptions(files, plan, {
        fileSystem,
        randomId: (() => {
          const ids = [
            'aaaaaaaaaaaaaaaa',
            'bbbbbbbbbbbbbbbb',
            'cccccccccccccccc',
          ];
          return () => ids.shift();
        })(),
      })),
      (error) => error.message === 'POST_WRITE_HASH_MISMATCH_ROLLED_BACK',
    );
    assert.ok(renameCount >= 2, 'replacement and rollback must both use rename');
    assert.deepEqual(await fs.readFile(files.stateFile), originalBytes);
    const restoredStat = await fs.stat(files.stateFile);
    assert.equal(restoredStat.uid, originalStat.uid);
    assert.equal(restoredStat.gid, originalStat.gid);
    assert.equal(restoredStat.mode & 0o777, originalStat.mode & 0o777);
    const entries = await fs.readdir(dir);
    assert.equal(entries.filter((name) => name.endsWith('.bak')).length, 1);
    assert.deepEqual(entries.filter((name) => name.endsWith('.tmp')), []);
  });
});

test('CLI exact-plan dry-run output can be applied byte-for-byte; success exposes basename only', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const dryRun = spawnSync(
      process.execPath,
      [SCRIPT_PATH, ...cliPathArguments(files), '--planned-updated-at', PLANNED_UPDATED_AT],
      { encoding: 'utf8' },
    );
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    const plan = JSON.parse(dryRun.stdout);
    const apply = spawnSync(
      process.execPath,
      [SCRIPT_PATH, ...cliApplyArguments(files, plan)],
      { encoding: 'utf8' },
    );
    assert.equal(apply.status, 0, apply.stderr || apply.stdout);
    const payload = JSON.parse(apply.stdout);
    assert.deepEqual(Object.keys(payload).sort(), [
      'backupBasename',
      'inputSha256',
      'mode',
      'ok',
      'plannedStateSha256',
      'plannedUpdatedAt',
      'preservedStoreCount',
      'resettableStoreCount',
      'storeCodes',
      'unchangedStoreCodes',
    ]);
    assert.equal(payload.mode, 'apply');
    assert.equal(payload.plannedUpdatedAt, plan.plannedUpdatedAt);
    assert.equal(payload.plannedStateSha256, plan.plannedStateSha256);
    assert.equal(path.basename(payload.backupBasename), payload.backupBasename);
    assert.ok(!payload.backupBasename.includes('/') && !payload.backupBasename.includes('\\'));
    assert.ok(!apply.stdout.includes(dir));
    await fs.access(path.join(dir, payload.backupBasename));
    const writtenBytes = await fs.readFile(files.stateFile);
    assert.equal(sha256(writtenBytes), plan.plannedStateSha256);
  });
});

test('CLI apply without exact-plan arguments fails closed with non-sensitive output', async () => {
  await withTempInputs(async ({ dir, files }) => {
    const before = await snapshotDirectory(dir);
    const run = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--apply', ...cliPathArguments(files)],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    assert.deepEqual(JSON.parse(run.stdout), {
      ok: false,
      errorCode: 'PLANNED_UPDATED_AT_REQUIRED',
    });
    assert.ok(!run.stdout.includes(dir));
    assert.deepEqual(await snapshotDirectory(dir), before);
  });
});

test('argument parser accepts the exact-plan gate and rejects malformed inputs', () => {
  const hash = 'a'.repeat(64);
  const parsed = parseArguments([
    '--apply',
    '--planned-updated-at', PLANNED_UPDATED_AT,
    '--expected-planned-state-sha256', hash,
  ]);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.plannedUpdatedAt, PLANNED_UPDATED_AT);
  assert.equal(parsed.expectedPlannedStateSha256, hash);
  assert.throws(
    () => parseArguments(['--bogus']),
    (error) => error.message === 'UNKNOWN_ARGUMENT',
  );
  assert.throws(
    () => parseArguments(['--planned-updated-at', 'not-an-iso-time']),
    (error) => error.message === 'INVALID_PLANNED_UPDATED_AT',
  );
  assert.throws(
    () => parseArguments(['--expected-planned-state-sha256', 'deadbeef']),
    (error) => error.message === 'INVALID_EXPECTED_SHA256',
  );
});
