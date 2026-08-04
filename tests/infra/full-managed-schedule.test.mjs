import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildScheduledPlan,
  HOME_DAILY_BATCH_SIZE,
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
  });
});

test('hourly homepage plan fetches only the current realtime contract', () => {
  const plan = buildScheduledPlan({
    task: 'home-realtime',
    now: new Date('2026-08-03T00:00:00+08:00'),
  });
  assert.equal(plan.openApiLease, false);
  assert.equal(plan.stores.length, 25);
  assert.deepEqual(plan.commands[0].args.slice(1), [
    `--stores=${FULL_MANAGED_STORE_CODES.join(',')}`,
    '--from=2026-08-03',
    '--to=2026-08-03',
    '--no-products',
    '--execute',
  ]);
});

test('daily homepage schedule maps five hourly slots to disjoint five-store batches', () => {
  assert.equal(HOME_DAILY_BATCH_SIZE, 5);
  const selected = [];
  for (let hour = 5; hour <= 9; hour += 1) {
    const plan = buildScheduledPlan({
      task: 'home-daily-batch',
      now: new Date(`2026-08-03T${String(hour).padStart(2, '0')}:20:00+08:00`),
    });
    assert.equal(plan.batch, hour - 5);
    assert.equal(plan.stores.length, 5);
    assert.equal(plan.commands.length, 2);
    assert.ok(plan.commands[0].args.includes('--require-settled-through=2026-08-02'));
    assert.ok(plan.commands[0].args.includes('--refresh-recent-days=2'));
    selected.push(...plan.stores);
  }
  assert.deepEqual(selected, FULL_MANAGED_STORE_CODES);
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
  const [realtime, sales, supply, daily, finance, materializer] = await Promise.all([
    readFile(new URL('infra/systemd/shein-fm-home-realtime.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-sales-sync.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-supply-sync.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-daily.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-home-finance-daily.timer', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-dashboard-materialize.timer', root), 'utf8'),
  ]);
  assert.match(realtime, /OnCalendar=\*-\*-\* \*:00:00 Asia\/Shanghai/);
  assert.match(sales, /OnCalendar=\*-\*-\* \*:12:00 Asia\/Shanghai/);
  assert.match(supply, /OnCalendar=\*-\*-\* 03:40:00 Asia\/Shanghai/);
  assert.match(daily, /OnCalendar=\*-\*-\* 05\.\.09:20:00 Asia\/Shanghai/);
  assert.match(finance, /OnCalendar=\*-\*-\* 04:20:00 Asia\/Shanghai/);
  assert.match(materializer, /OnUnitInactiveSec=30m/);
});
