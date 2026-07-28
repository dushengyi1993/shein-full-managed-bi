import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createDashboardUpdateBroker } from '../../src/server/dashboard-update-stream.mjs';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.writes = [];
    this.statusCode = null;
    this.destroyed = false;
    this.writableEnded = false;
  }

  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }

  flushHeaders() {}

  write(value) {
    this.writes.push(String(value));
    return true;
  }

  end() {
    this.writableEnded = true;
    this.emit('close');
  }
}

test('one shared SSE broker emits update evidence and releases timers on disconnect', async () => {
  let version = { mtimeMs: 1000, size: 50 };
  const timers = [];
  const cleared = [];
  const broker = createDashboardUpdateBroker({
    dataFile: '/private/path/dashboard.json',
    statFile: async () => version,
    pollIntervalMs: 20,
    heartbeatIntervalMs: 30,
    setIntervalFn(fn) {
      const timer = { fn, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { cleared.push(timer); },
  });
  const request = new EventEmitter();
  const response = new FakeResponse();

  broker.open(request, response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.subscriberCount, 1);
  assert.equal(broker.timersActive, true);
  assert.equal(timers.length, 2);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.match(response.writes.join(''), /event: ready/);
  assert.doesNotMatch(response.writes.join(''), /private|dashboard\.json/);

  version = { mtimeMs: 2000, size: 60 };
  await broker.checkForUpdate();
  const output = response.writes.join('');
  assert.match(output, /event: dashboard-updated/);
  assert.match(output, /2000-60/);
  assert.doesNotMatch(output, /private|dashboard\.json/);

  request.emit('close');
  assert.equal(broker.subscriberCount, 0);
  assert.equal(broker.timersActive, false);
  assert.equal(cleared.length, 2);
  broker.close();
});

test('closing the broker ends subscribers and is idempotent', () => {
  const broker = createDashboardUpdateBroker({
    dataFile: '/bounded/dashboard.json',
    statFile: async () => ({ mtimeMs: 1, size: 1 }),
    pollIntervalMs: 20,
    heartbeatIntervalMs: 30,
    setIntervalFn() { return { unref() {} }; },
    clearIntervalFn() {},
  });
  const response = new FakeResponse();
  broker.open(new EventEmitter(), response);
  broker.close();
  broker.close();
  assert.equal(response.writableEnded, true);
  assert.equal(broker.subscriberCount, 0);
  assert.equal(broker.timersActive, false);
});
