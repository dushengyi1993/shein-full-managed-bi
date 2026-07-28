/**
 * Linux wiring for the manually operated WebAPI experiment.
 *
 * This module is dynamically imported only after the CLI has validated the
 * execute flag, exact plan hash, exact store/endpoint allow-lists and the
 * dedicated database URL. Importing it has no side effect; processes, sockets
 * and database connections are created only by createLinuxExperimentRuntime.
 */

import { spawn as spawnChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';

import { Pool } from 'pg';

import { createWebApiExperimentAdapter } from './adapter.mjs';
import {
  openExperimentSession,
  sessionStateForFailure,
} from './browser-session.mjs';
import { createPageContextTransport } from './page-transport.mjs';
import { createExperimentLockManager } from './profile-lock.mjs';
import { createWebApiExperimentRepository } from './repository.mjs';

const LOCK_DIRECTORY = '/srv/shein-fm/runtime/webapi-locks';
const LOOPBACK_DEBUG_PATH = /^http:\/\/127\.0\.0\.1:(39541|39542)\/json\/(version|list)$/;
const MAX_DEBUG_RESPONSE_BYTES = 1024 * 1024;

export const LINUX_EXECUTABLES = Object.freeze({
  chrome: Object.freeze([
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]),
  xvfb: Object.freeze(['/usr/bin/Xvfb']),
});

export class WebApiLinuxRuntimeError extends Error {
  constructor(code) {
    super(`webapi linux runtime refused: ${code}`);
    this.name = 'WebApiLinuxRuntimeError';
    this.code = code;
  }
}

function fail(code) {
  throw new WebApiLinuxRuntimeError(code);
}

async function defaultPathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultWhich(name) {
  const candidates = LINUX_EXECUTABLES[String(name ?? '').toLowerCase()] ?? [];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next fixed candidate. PATH is deliberately not consulted.
    }
  }
  return null;
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function defaultSpawn(executable, args, options) {
  return spawnChildProcess(executable, args, options);
}

function safeChildEnvironment(source, display) {
  const environment = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR']) {
    if (typeof source?.[key] === 'string' && source[key] !== '') {
      environment[key] = source[key];
    }
  }
  if (display) environment.DISPLAY = display;
  return environment;
}

async function defaultHttpJson(url, { timeoutMs = 4_000 } = {}) {
  if (!LOOPBACK_DEBUG_PATH.test(String(url ?? ''))) {
    fail('WEBAPI_RUNTIME_DEBUG_URL_NOT_ALLOWED');
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) fail('WEBAPI_RUNTIME_DEBUG_HTTP_FAILED');
  const text = await response.text();
  if (text.length > MAX_DEBUG_RESPONSE_BYTES) {
    fail('WEBAPI_RUNTIME_DEBUG_RESPONSE_TOO_LARGE');
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('WEBAPI_RUNTIME_DEBUG_RESPONSE_INVALID');
  }
}

function createDefaultSystem() {
  return {
    platform: process.platform,
    pid: process.pid,
    env: process.env,
    pathExists: defaultPathExists,
    which: defaultWhich,
    isProcessAlive: defaultIsProcessAlive,
    spawn: defaultSpawn,
    httpJson: defaultHttpJson,
    createWebSocket: (url) => new WebSocket(url),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    fs: {
      mkdir: (path) => mkdir(path, { recursive: true, mode: 0o700 }),
      writeFileExclusive: (path, value) => writeFile(path, value, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
      readFile: (path) => readFile(path, 'utf8'),
      remove: (path) => unlink(path),
    },
    PoolClass: Pool,
  };
}

function assertDatabaseUrl(value) {
  const text = String(value ?? '');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    fail('WEBAPI_DATABASE_URL_INVALID');
  }
  if (
    parsed.protocol !== 'postgresql:'
    || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    || parsed.port !== '54330'
    || parsed.username !== 'sheinfm_webapi_login'
    || parsed.password.length < 24
    || parsed.pathname !== '/shein_fm'
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    fail('WEBAPI_DATABASE_URL_INVALID');
  }
  return text;
}

/**
 * Build the real Linux dependencies without broadening business scope.
 *
 * Tests inject every system capability. The production defaults use only fixed
 * executable paths, loopback CDP URLs, tracked child handles and the dedicated
 * experiment database role.
 */
export async function createLinuxExperimentRuntime({
  databaseUrl,
  system = createDefaultSystem(),
} = {}) {
  if (system.platform !== 'linux') fail('WEBAPI_RUNTIME_PLATFORM_UNSUPPORTED');
  const connectionString = assertDatabaseUrl(databaseUrl);
  if (
    !Number.isSafeInteger(system.pid)
    || !system.fs
    || typeof system.pathExists !== 'function'
    || typeof system.which !== 'function'
    || typeof system.isProcessAlive !== 'function'
    || typeof system.spawn !== 'function'
    || typeof system.httpJson !== 'function'
    || typeof system.createWebSocket !== 'function'
    || typeof system.sleep !== 'function'
    || typeof system.PoolClass !== 'function'
  ) {
    fail('WEBAPI_RUNTIME_DEPENDENCIES_MISSING');
  }

  const executableCache = new Map();
  async function resolveExecutable(name) {
    if (!executableCache.has(name)) {
      executableCache.set(name, await system.which(name));
    }
    return executableCache.get(name);
  }

  const children = new Map();

  async function spawnTracked(command, args, { display } = {}) {
    const executable = await resolveExecutable(command);
    if (!executable) fail('WEBAPI_RUNTIME_EXECUTABLE_MISSING');
    const child = system.spawn(executable, args, {
      detached: false,
      stdio: 'ignore',
      // Browser/display children never inherit the database URL or any other
      // application secret from the operator environment.
      env: safeChildEnvironment(system.env, display),
    });
    if (!child || !Number.isSafeInteger(child.pid)) {
      fail('WEBAPI_RUNTIME_PROCESS_START_FAILED');
    }
    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off?.('error', onError);
        resolve();
      };
      const onError = () => {
        child.off?.('spawn', onSpawn);
        reject(new WebApiLinuxRuntimeError('WEBAPI_RUNTIME_PROCESS_START_FAILED'));
      };
      child.once?.('spawn', onSpawn);
      child.once?.('error', onError);
      if (typeof child.once !== 'function') resolve();
    });
    children.set(child.pid, child);
    child.once?.('exit', () => children.delete(child.pid));
    return { pid: child.pid };
  }

  async function terminateTracked(pid, { graceMs = 4_000 } = {}) {
    const child = children.get(pid);
    if (!child) return { terminated: false };
    const exited = new Promise((resolve) => child.once?.('exit', resolve));
    try {
      child.kill('SIGTERM');
    } catch {
      children.delete(pid);
      return { terminated: false };
    }
    const graceful = await Promise.race([
      exited.then(() => true),
      system.sleep(graceMs).then(() => false),
    ]);
    if (!graceful) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The tracked child exited between the grace timeout and this signal.
      }
    }
    children.delete(pid);
    return { terminated: true };
  }

  const lockManager = createExperimentLockManager({
    fs: system.fs,
    pid: system.pid,
    isProcessAlive: system.isProcessAlive,
    lockDirectory: LOCK_DIRECTORY,
  });
  const pool = new system.PoolClass({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: 'shein_fm_webapi_experiment',
  });
  const repository = createWebApiExperimentRepository({ pool });

  const deps = Object.freeze({
    repository,
    sessionStateForFailure,
    openSession: ({ storeCode }) => openExperimentSession({
      storeCode,
      deps: {
        platform: system.platform,
        spawn: spawnTracked,
        pathExists: system.pathExists,
        which: resolveExecutable,
        httpJson: system.httpJson,
        createWebSocket: system.createWebSocket,
        lockManager,
        terminate: terminateTracked,
        sleep: system.sleep,
      },
    }),
    createTransport: ({ session, endpointCode, request }) => createPageContextTransport({
      session,
      endpointCode,
      request,
    }),
    createAdapter: ({ storeCode, transport }) => createWebApiExperimentAdapter({
      storeCode,
      transport,
    }),
  });

  let closed = false;
  async function close() {
    if (closed) return { closed: false };
    closed = true;
    for (const pid of [...children.keys()]) {
      await terminateTracked(pid).catch(() => {});
    }
    await pool.end();
    return { closed: true };
  }

  return Object.freeze({ deps, close });
}
