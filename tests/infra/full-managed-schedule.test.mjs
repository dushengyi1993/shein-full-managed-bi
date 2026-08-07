import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildScheduledPlan,
  HOME_DAILY_BATCH_BY_SLOT,
  HOME_DAILY_BATCH_SIZE,
  HOME_REALTIME_BATCH_BY_MINUTE,
  HOME_REALTIME_BATCHES,
  OPENAPI_SCHEDULE_LOCK_ID,
  runPlan,
  scheduledDates,
  selectRetryStoresFromMarkerPayloads,
} from '../../scripts/run_full_managed_scheduled_task.mjs';
import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

const root = new URL('../../', import.meta.url);

test('scheduled dates use the Shanghai business calendar', () => {
  assert.deepEqual(scheduledDates(new Date('2026-08-03T17:30:00+08:00')), {
    today: '2026-08-03',
    yesterday: '2026-08-02',
    twoDaysAgo: '2026-08-01',
    fourDaysAgo: '2026-07-30',
    eightDaysAgo: '2026-07-26',
    shanghaiHour: 17,
    shanghaiMinute: 30,
  });
});

test('hourly homepage plan refreshes all stores through one browserless HTTP batch', () => {
  assert.deepEqual(HOME_REALTIME_BATCH_BY_MINUTE, { 2: 0 });
  assert.deepEqual(
    HOME_REALTIME_BATCHES.flat(),
    FULL_MANAGED_STORE_CODES,
  );
  assert.deepEqual(HOME_REALTIME_BATCHES.map((stores) => stores.length), [25]);
  for (const [minute, batch] of [[2, 0]]) {
    const plan = buildScheduledPlan({
      task: 'home-realtime',
      now: new Date(`2026-08-03T00:${String(minute).padStart(2, '0')}:00+08:00`),
    });
    assert.equal(plan.openApiLease, false);
    assert.equal(plan.batch, batch);
    assert.deepEqual(plan.stores, HOME_REALTIME_BATCHES[batch]);
    assert.deepEqual(plan.commands[0].args.slice(1), [
      `--stores=${HOME_REALTIME_BATCHES[batch].join(',')}`,
      '--from=2026-08-03',
      '--to=2026-08-03',
      '--retry-cdp=1',
      '--execute',
    ]);
  }
  assert.throws(
    () => buildScheduledPlan({
      task: 'home-realtime',
      now: new Date('2026-08-03T00:17:00+08:00'),
    }),
    /SCHEDULE_REALTIME_BATCH_INVALID/,
  );
});

test('daily homepage schedule maps five early slots to disjoint five-store batches', () => {
  assert.equal(HOME_DAILY_BATCH_SIZE, 5);
  assert.deepEqual(HOME_DAILY_BATCH_BY_SLOT, {
    '03:45': 0,
    '04:15': 1,
    '04:45': 2,
    '05:15': 3,
    '05:45': 4,
  });
  const selected = [];
  const slots = [
    [3, 45, 0],
    [4, 15, 1],
    [4, 45, 2],
    [5, 15, 3],
    [5, 45, 4],
  ];
  for (const [hour, minute, batch] of slots) {
    const plan = buildScheduledPlan({
      task: 'home-daily-batch',
      now: new Date(`2026-08-03T${String(hour).padStart(2, '0')}:${minute}:00+08:00`),
    });
    assert.equal(plan.batch, batch);
    assert.equal(plan.stores.length, 5);
    assert.equal(plan.commands.length, 2);
    assert.ok(plan.commands[0].args.includes('--require-settled-through=2026-08-02'));
    assert.ok(plan.commands[0].args.includes('--refresh-recent-days=2'));
    assert.ok(plan.commands[0].args.includes('--retry-cdp=1'));
    assert.ok(plan.commands[1].args.includes('--retry-cdp=1'));
    selected.push(...plan.stores);
  }
  assert.deepEqual(selected, FULL_MANAGED_STORE_CODES);
  assert.throws(
    () => buildScheduledPlan({
      task: 'home-daily-batch',
      now: new Date('2026-08-03T08:20:00+08:00'),
    }),
    /SCHEDULE_BATCH_INVALID/,
  );
});

test('a partial history command still runs ledger but remains non-publishable', async () => {
  const seen = [];
  const exitCode = await runPlan({
    commands: [
      { executable: 'node', args: ['history'], partialExitCodes: [2] },
      { executable: 'node', args: ['ledger'], partialExitCodes: [2] },
    ],
  }, async (entry) => {
    seen.push(entry.args[0]);
    return entry.args[0] === 'history' ? 2 : 0;
  });
  assert.deepEqual(seen, ['history', 'ledger']);
  assert.equal(exitCode, 2);
});

test('daily retry selects only batches without a successful terminal marker', () => {
  const businessDate = '2026-08-03';
  const payloads = [0, 2, 4].map((batch) => ({
    task: 'home-daily-batch',
    businessDate,
    batch,
    status: 'SUCCEEDED',
  }));
  payloads.push({
    task: 'home-daily-batch',
    businessDate,
    batch: 1,
    status: 'PARTIAL',
  });
  const selected = selectRetryStoresFromMarkerPayloads(payloads, businessDate);
  assert.deepEqual(selected, [
    ...FULL_MANAGED_STORE_CODES.slice(5, 10),
    ...FULL_MANAGED_STORE_CODES.slice(15, 20),
  ]);
  const plan = buildScheduledPlan({
    task: 'home-daily-retry',
    retryStores: selected,
    now: new Date('2026-08-03T06:15:00+08:00'),
  });
  assert.equal(plan.stores.length, 10);
  assert.ok(plan.commands.every(({ args }) => (
    args.includes(`--stores=${selected.join(',')}`)
  )));
});

test('OpenAPI schedules share one advisory lease and keep finance on settled D-2', () => {
  assert.match(OPENAPI_SCHEDULE_LOCK_ID, /^\d+$/);
  for (const task of ['sales-hourly', 'supply-daily', 'finance-daily']) {
    assert.equal(buildScheduledPlan({
      task,
      now: new Date('2026-08-03T04:20:00+08:00'),
    }).openApiLease, true);
  }
  const finance = buildScheduledPlan({
    task: 'finance-daily',
    now: new Date('2026-08-03T04:20:00+08:00'),
  });
  assert.ok(finance.commands[0].args.includes('--from=2026-07-26'));
  assert.ok(finance.commands[0].args.includes('--to=2026-08-01'));
  assert.ok(finance.commands[0].args.includes('--concurrency=1'));
  assert.ok(finance.commands[0].args.includes('--no-resume'));
});

test('systemd schedule exposes one timer per logical full-managed task', async () => {
  const [
    realtime,
    supply,
    daily,
    finance,
    session,
    backup,
    restore,
    materializerRetry,
  ] = await Promise.all([
    readFile(new URL('infra/systemd/shein-fm-home-realtime.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-supply-sync.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-daily.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-finance-daily.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-session-renewal.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-db-backup.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-db-restore-test.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-dashboard-materialize-retry.timer', root), 'utf8'),
  ]);
  assert.match(realtime, /OnCalendar=\*-\*-\* \*:02:00 Asia\/Shanghai/);
  assert.doesNotMatch(realtime, /\*:32:00/);
  assert.match(supply, /OnCalendar=\*-\*-\* 02:20:00 Asia\/Shanghai/);
  assert.match(daily, /OnCalendar=\*-\*-\* 05:45:00 Asia\/Shanghai/);
  assert.doesNotMatch(daily, /03:45|04:15|04:45|05:15/);
  assert.match(finance, /OnCalendar=\*-\*-\* 03:15:00 Asia\/Shanghai/);
  assert.match(session, /OnCalendar=\*-\*-\* 00:30:00 Asia\/Shanghai/);
  assert.match(backup, /OnCalendar=Sun \*-\*-\* 00:15:00 Asia\/Shanghai/);
  assert.match(restore, /OnCalendar=Sun \*-\*-01\.\.07 01:15:00 Asia\/Shanghai/);
  assert.doesNotMatch(backup, /Persistent=true/);
  assert.doesNotMatch(restore, /Persistent=true/);
  assert.match(materializerRetry, /OnCalendar=\*-\*-\* \*:09,19,29,39,49,59:00 Asia\/Shanghai/);
  assert.doesNotMatch(materializerRetry, /Persistent=true|OnBootSec=/);
});

test('coordinator units own bounded end-to-end business windows', async () => {
  const [
    realtimeTimer,
    realtime,
    session,
    supply,
    finance,
    daily,
    backup,
    restore,
    materializer,
  ] = await Promise.all([
    readFile(new URL('infra/systemd/shein-fm-home-realtime.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-realtime.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-session-renewal.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-supply-sync.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-finance-daily.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-daily.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-db-backup.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-db-restore-test.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-dashboard-materialize.service', root), 'utf8'),
  ]);
  assert.match(realtimeTimer, /^AccuracySec=1s$/m);
  assert.match(realtime, /^TimeoutStartSec=12min$/m);
  assert.match(realtime, /--task=realtime-cockpit --execute/);
  assert.match(realtime, /^Environment=SHEIN_FM_CLOUD_EXECUTION=1$/m);
  assert.match(session, /^TimeoutStartSec=25min$/m);
  assert.match(session, /--task=session-maintenance --execute/);
  assert.match(supply, /^TimeoutStartSec=60min$/m);
  assert.match(finance, /^TimeoutStartSec=35min$/m);
  assert.match(daily, /^TimeoutStartSec=80min$/m);
  assert.match(daily, /--task=daily-operations --execute/);
  assert.match(backup, /^TimeoutStartSec=20min$/m);
  assert.match(backup, /backup_full_managed_db\.sh --mode weekly/);
  assert.match(restore, /^TimeoutStartSec=45min$/m);
  assert.match(materializer, /^TimeoutStartSec=5min$/m);
});
