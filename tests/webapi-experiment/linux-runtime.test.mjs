import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  createLinuxExperimentRuntime,
  WebApiLinuxRuntimeError,
} from '../../src/webapi-experiment/linux-runtime.mjs';

const DATABASE_URL = 'postgresql://sheinfm_webapi_login:123456789012345678901234@127.0.0.1:54330/shein_fm';

class FakePool {
  constructor(config) {
    this.config = config;
    this.ended = false;
  }

  async connect() {
    return {
      async query() { return { rows: [], rowCount: 0 }; },
      release() {},
    };
  }

  async end() {
    this.ended = true;
  }
}

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  send(text) {
    const request = JSON.parse(text);
    let result = {};
    if (request.method === 'Runtime.evaluate') {
      result = {
        result: {
          value: {
            sameOrigin: true,
            onLoginView: false,
            aliasPresent: true,
            textLength: 100,
          },
        },
      };
    }
    queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({ id: request.id, result }),
    }));
  }

  close() {
    this.emit('close', {});
  }
}

function memoryLockFs() {
  const files = new Map();
  return {
    async mkdir() {},
    async writeFileExclusive(path, value) {
      if (files.has(path)) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      files.set(path, value);
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error('missing');
      return files.get(path);
    },
    async remove(path) {
      files.delete(path);
    },
  };
}

function fakeSystem({ platform = 'linux' } = {}) {
  const spawns = [];
  const children = [];
  return {
    platform,
    pid: 4321,
    env: {
      PATH: '/usr/bin',
      HOME: '/srv/shein-fm',
      LANG: 'C.UTF-8',
      FULL_BI_WEBAPI_DATABASE_URL: DATABASE_URL,
      UNRELATED_SECRET: 'must-not-reach-child',
    },
    fs: memoryLockFs(),
    pathExists: async () => true,
    which: async (name) => (name === 'chrome' ? '/usr/bin/google-chrome' : '/usr/bin/Xvfb'),
    isProcessAlive: () => false,
    spawn(executable, args, options) {
      const child = new EventEmitter();
      child.pid = 5000 + children.length;
      child.kill = () => {
        queueMicrotask(() => child.emit('exit', 0));
        return true;
      };
      children.push(child);
      spawns.push({ executable, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    httpJson: async (url) => (
      url.endsWith('/json/list')
        ? [{
          type: 'page',
          url: 'https://sso.geiwohuo.com/#/home',
          webSocketDebuggerUrl: 'ws://127.0.0.1:39541/devtools/page/1',
        }]
        : {}
    ),
    createWebSocket: () => new FakeSocket(),
    sleep: async () => {},
    PoolClass: FakePool,
    spawns,
    children,
  };
}

test('runtime rejects non-Linux and non-dedicated database URLs before a process', async () => {
  const windows = fakeSystem({ platform: 'win32' });
  await assert.rejects(
    () => createLinuxExperimentRuntime({ databaseUrl: DATABASE_URL, system: windows }),
    (error) => error instanceof WebApiLinuxRuntimeError
      && error.code === 'WEBAPI_RUNTIME_PLATFORM_UNSUPPORTED',
  );
  assert.equal(windows.spawns.length, 0);

  const linux = fakeSystem();
  await assert.rejects(
    () => createLinuxExperimentRuntime({
      databaseUrl: 'postgresql://other:password@remote.example:5432/other',
      system: linux,
    }),
    (error) => error.code === 'WEBAPI_DATABASE_URL_INVALID',
  );
  assert.equal(linux.spawns.length, 0);
});

test('runtime starts only fixed executables and strips secrets from child environments', async () => {
  const system = fakeSystem();
  const runtime = await createLinuxExperimentRuntime({
    databaseUrl: DATABASE_URL,
    system,
  });
  const session = await runtime.deps.openSession({ storeCode: 'DL5477' });
  assert.equal(session.storeCode, 'DL5477');
  assert.equal(system.spawns.length, 2);
  assert.deepEqual(system.spawns.map((entry) => entry.executable), [
    '/usr/bin/Xvfb',
    '/usr/bin/google-chrome',
  ]);
  for (const entry of system.spawns) {
    assert.equal(entry.options.env.FULL_BI_WEBAPI_DATABASE_URL, undefined);
    assert.equal(entry.options.env.UNRELATED_SECRET, undefined);
    assert.equal(entry.options.env.PATH, '/usr/bin');
  }
  assert.equal(system.spawns[1].options.env.DISPLAY, ':941');
  await session.close();
  assert.equal(system.children.length, 2);
  await runtime.close();
});

test('runtime creation itself opens no browser and closes its dedicated pool', async () => {
  const system = fakeSystem();
  const runtime = await createLinuxExperimentRuntime({
    databaseUrl: DATABASE_URL,
    system,
  });
  assert.equal(system.spawns.length, 0);
  assert.equal(runtime.deps.repository !== null, true);
  assert.deepEqual(await runtime.close(), { closed: true });
  assert.deepEqual(await runtime.close(), { closed: false });
});
