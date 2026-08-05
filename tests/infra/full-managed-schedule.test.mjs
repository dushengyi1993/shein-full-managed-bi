import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildScheduledPlan,
  HOME_DAILY_BATCH_BY_HOUR,
  HOME_DAILY_BATCH_SIZE,
  HOME_REALTIME_BATCH_BY_MINUTE,
  HOME_REALTIME_BATCHES,
  OPENAPI_SCHEDULE_LOCK_ID,
  runPlan,
  scheduledDates,
} from '../../scripts/run_full_managed_scheduled_task.mjs';
import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

const root = new URL('../../', import.meta.url);

test('scheduled dates use the Shanghai business calendar', () => {
  assert.deepEqual(scheduledDates(new Date('2026-08-03T17:30:00+08:00')), {
    today: '2026-08-03',
    yesterday: '2026-08-02',
    twoDaysAgo: '2026-08-01',
    fourDaysAgo: '2026-07-30',
    shanghaiHour: 17,
    shanghaiMinute: 30,
  });
});

test('hourly homepage plan splits the realtime contract into two bounded batches', () => {
  assert.deepEqual(HOME_REALTIME_BATCH_BY_MINUTE, { 2: 0, 32: 1 });
  assert.deepEqual(
    HOME_REALTIME_BATCHES.flat(),
    FULL_MANAGED_STORE_CODES,
  );
  assert.deepEqual(HOME_REALTIME_BATCHES.map((stores) => stores.length), [12, 13]);
  for (const [minute, batch] of [[2, 0], [32, 1]]) {
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
      '--no-products',
      '--retry-cdp=1',
      '--allow-partial',
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

test('daily homepage schedule maps five post-core slots to disjoint five-store batches', () => {
  assert.equal(HOME_DAILY_BATCH_SIZE, 5);
  assert.deepEqual(HOME_DAILY_BATCH_BY_HOUR, {
    5: 0,
    6: 1,
    7: 2,
    9: 3,
    10: 4,
  });
  const selected = [];
  const slots = [
    [5, 0],
    [6, 1],
    [7, 2],
    [9, 3],
    [10, 4],
  ];
  for (const [hour, batch] of slots) {
    const plan = buildScheduledPlan({
      task: 'home-daily-batch',
      now: new Date(`2026-08-03T${String(hour).padStart(2, '0')}:45:00+08:00`),
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

test('a partial history command does not prevent the independent ledger refresh', async () => {
  const seen = [];
  const exitCode = await runPlan({
    commands: [
      { executable: 'node', args: ['history'] },
      { executable: 'node', args: ['ledger'] },
    ],
  }, async (entry) => {
    seen.push(entry.args[0]);
    return entry.args[0] === 'history' ? 2 : 0;
  });
  assert.deepEqual(seen, ['history', 'ledger']);
  assert.equal(exitCode, 2);
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
  assert.ok(finance.commands[0].args.includes('--from=2026-07-30'));
  assert.ok(finance.commands[0].args.includes('--to=2026-08-01'));
  assert.ok(finance.commands[0].args.includes('--concurrency=1'));
  assert.ok(finance.commands[0].args.includes('--no-resume'));
});

test('systemd schedule keeps hourly work ahead of bounded daily batches', async () => {
  const [
    realtime,
    sales,
    supply,
    daily,
    retry,
    finance,
    session,
    backup,
    archive,
    materializer,
    materializerRetry,
  ] = await Promise.all([
    readFile(new URL('infra/systemd/shein-fm-home-realtime.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-sales-sync.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-supply-sync.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-daily.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-daily-retry.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-finance-daily.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-session-renewal.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-db-backup.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-backup-archive.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-dashboard-materialize.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-dashboard-materialize-retry.timer', root), 'utf8'),
  ]);
  assert.match(realtime, /OnCalendar=\*-\*-\* \*:02:00 Asia\/Shanghai/);
  assert.match(realtime, /OnCalendar=\*-\*-\* \*:32:00 Asia\/Shanghai/);
  assert.match(sales, /OnCalendar=\*-\*-\* \*:05:00 Asia\/Shanghai/);
  assert.match(supply, /OnCalendar=\*-\*-\* 03:45:00 Asia\/Shanghai/);
  assert.match(daily, /OnCalendar=\*-\*-\* 05\.\.07:45:00 Asia\/Shanghai/);
  assert.match(daily, /OnCalendar=\*-\*-\* 09\.\.10:45:00 Asia\/Shanghai/);
  assert.match(retry, /OnCalendar=\*-\*-\* 11:50:00 Asia\/Shanghai/);
  assert.match(finance, /OnCalendar=\*-\*-\* 04:45:00 Asia\/Shanghai/);
  assert.match(session, /OnCalendar=\*-\*-\* 02:10:00 Asia\/Shanghai/);
  assert.match(backup, /OnCalendar=\*-\*-\* 01:55:00 Asia\/Shanghai/);
  assert.match(archive, /OnCalendar=\*-\*-\* 12:45:00 Asia\/Shanghai/);
  assert.doesNotMatch(backup, /Persistent=true/);
  assert.doesNotMatch(archive, /Persistent=true/);
  assert.match(materializer, /OnCalendar=\*-\*-\* 00\.\.23\/2:55:00 Asia\/Shanghai/);
  assert.doesNotMatch(materializer, /OnUnitInactiveSec=/);
  assert.doesNotMatch(materializer, /OnBootSec=/);
  assert.match(materializerRetry, /OnCalendar=\*-\*-\* \*:00\.\.24\/3:00 Asia\/Shanghai/);
  assert.match(materializerRetry, /OnCalendar=\*-\*-\* \*:47\.\.59\/3:00 Asia\/Shanghai/);
  assert.doesNotMatch(materializerRetry, /Persistent=true|OnBootSec=/);
});

test('every heavy window has a hard stop before the next core lane', async () => {
  const [
    realtimeTimer,
    realtime,
    sales,
    session,
    supply,
    finance,
    daily,
    retry,
    backup,
    archive,
    materializer,
  ] = await Promise.all([
    readFile(new URL('infra/systemd/shein-fm-home-realtime.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-realtime.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-sales-sync.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-session-renewal.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-supply-sync.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-finance-daily.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-daily.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-daily-retry.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-db-backup.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-backup-archive.service', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-dashboard-materialize.service', root), 'utf8'),
  ]);
  assert.match(realtimeTimer, /^AccuracySec=1s$/m);
  assert.match(realtime, /^TimeoutStartSec=11min$/m);
  assert.match(sales, /^TimeoutStartSec=15min$/m);
  assert.match(session, /^TimeoutStartSec=10min$/m);
  assert.match(supply, /^TimeoutStartSec=35min$/m);
  assert.match(finance, /^TimeoutStartSec=15min$/m);
  assert.match(daily, /^TimeoutStartSec=35min$/m);
  assert.match(retry, /^TimeoutStartSec=25min$/m);
  assert.match(backup, /^TimeoutStartSec=15min$/m);
  assert.match(backup, /^Environment=FULL_BI_SKIP_BACKUP_ARCHIVE=1$/m);
  assert.match(archive, /^TimeoutStartSec=20min$/m);
  assert.match(archive, /--retain-days=7 --retain-extra=3/);
  assert.match(materializer, /^TimeoutStartSec=5min$/m);
});
