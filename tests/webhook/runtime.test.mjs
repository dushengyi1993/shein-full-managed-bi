import assert from 'node:assert/strict';
import test from 'node:test';

import {
  startWebhookRuntimeHeartbeat,
} from '../../src/webhook/runtime.mjs';

test('runtime heartbeat records startup, periodic liveness and graceful stop', async () => {
  const calls = [];
  const timers = [];
  let now = Date.parse('2026-07-26T12:00:00.000Z');
  const heartbeat = await startWebhookRuntimeHeartbeat({
    repository: {
      async recordRuntimeHeartbeat(input) {
        calls.push({
          ...input,
          observedAt: new Date(input.observedAt).toISOString(),
        });
      },
    },
    componentCode: 'RECEIVER',
    instanceId: 'host-a:123',
    intervalMs: 30_000,
    ttlMs: 90_000,
    now: () => now,
    setIntervalFn(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) {
      timer.cleared = true;
    },
  });

  assert.equal(calls[0].statusCode, 'RUNNING');
  assert.equal(calls[0].ttlMs, 90_000);
  assert.equal(timers[0].milliseconds, 30_000);
  now += 30_000;
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[1].observedAt, '2026-07-26T12:00:30.000Z');

  now += 1_000;
  await heartbeat.stop();
  assert.equal(timers[0].cleared, true);
  assert.equal(calls.at(-1).statusCode, 'STOPPING');
  assert.equal(calls.at(-1).ttlMs, 1_000);
});

test('runtime heartbeat rejects a TTL shorter than two intervals', async () => {
  await assert.rejects(
    () => startWebhookRuntimeHeartbeat({
      repository: { async recordRuntimeHeartbeat() {} },
      componentCode: 'WORKER',
      instanceId: 'host-a:124',
      intervalMs: 30_000,
      ttlMs: 30_000,
    }),
    /TTL must be at least twice/,
  );
});
