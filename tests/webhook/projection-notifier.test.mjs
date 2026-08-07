import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebhookProjectionNotifier } from '../../src/webhook/projection-notifier.mjs';

test('coalesces webhook bursts and wakes hydration only for actionable events', async () => {
  const writes = [];
  const timers = [];
  let clock = 1_786_096_800_000;
  const notifier = createWebhookProjectionNotifier({
    dashboardMarker: '/runtime/dashboard',
    hydrationMarker: '/runtime/hydration',
    minimumIntervalMs: 30_000,
    now: () => clock,
    writeMarker: async (file, value) => writes.push({ file, value }),
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });

  await notifier.request({ hydration: false });
  assert.deepEqual(writes.map(({ file }) => file), ['/runtime/dashboard']);

  clock += 1_000;
  await notifier.request({ hydration: true });
  await notifier.request({ hydration: false });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 29_000);

  clock += 29_000;
  timers[0].callback();
  await notifier.flush();
  assert.deepEqual(writes.map(({ file }) => file), [
    '/runtime/dashboard',
    '/runtime/dashboard',
    '/runtime/hydration',
  ]);
});

test('a notifier write failure is sanitized and does not crash the worker', async () => {
  const logs = [];
  const notifier = createWebhookProjectionNotifier({
    dashboardMarker: '/runtime/dashboard',
    hydrationMarker: '/runtime/hydration',
    minimumIntervalMs: 1_000,
    writeMarker: async () => {
      throw Object.assign(new Error('sensitive path detail'), { code: 'EACCES' });
    },
    logger: { error: (line) => logs.push(line) },
  });
  await notifier.request({ hydration: true });
  await notifier.stop();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EACCES/);
  assert.doesNotMatch(logs[0], /sensitive path detail/);
});
