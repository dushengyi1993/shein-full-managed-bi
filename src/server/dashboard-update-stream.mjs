import { stat } from 'node:fs/promises';

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 25_000;

function eventPayload(event, data, id = null) {
  const lines = [];
  if (id !== null) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

function safeWrite(response, payload) {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * One shared file-version watcher for every authenticated SSE subscriber.
 *
 * Timers exist only while at least one client is connected. Atomic rename is
 * detected by stat-ing the stable dashboard path; no filesystem path is ever
 * included in an event or error.
 */
export function createDashboardUpdateBroker({
  dataFile,
  statFile = stat,
  pollIntervalMs = DEFAULT_POLL_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof dataFile !== 'string' || dataFile.trim() === '') {
    throw new TypeError('dashboard update broker requires dataFile');
  }
  if (typeof statFile !== 'function') throw new TypeError('statFile must be a function');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new TypeError('pollIntervalMs must be at least 10ms');
  }
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 10) {
    throw new TypeError('heartbeatIntervalMs must be at least 10ms');
  }

  const subscribers = new Set();
  let pollTimer = null;
  let heartbeatTimer = null;
  let lastVersion = null;
  let checking = false;
  let closed = false;

  function stopTimers() {
    if (pollTimer !== null) clearIntervalFn(pollTimer);
    if (heartbeatTimer !== null) clearIntervalFn(heartbeatTimer);
    pollTimer = null;
    heartbeatTimer = null;
  }

  function remove(response) {
    subscribers.delete(response);
    if (subscribers.size === 0) stopTimers();
  }

  function broadcast(payload) {
    for (const response of [...subscribers]) {
      if (!safeWrite(response, payload)) remove(response);
    }
  }

  async function checkForUpdate() {
    if (checking || closed || subscribers.size === 0) return;
    checking = true;
    try {
      const file = await statFile(dataFile);
      const version = `${Math.trunc(file.mtimeMs)}-${file.size}`;
      if (lastVersion === null) {
        lastVersion = version;
      } else if (version !== lastVersion) {
        lastVersion = version;
        broadcast(eventPayload('dashboard-updated', {
          version,
          observedAt: new Date().toISOString(),
        }, version));
      }
    } catch {
      // The materializer promotes by atomic rename. A transient failed stat must
      // not leak a path or disconnect clients; the next shared poll retries.
    } finally {
      checking = false;
    }
  }

  function startTimers() {
    if (pollTimer !== null || closed) return;
    void checkForUpdate();
    pollTimer = setIntervalFn(() => { void checkForUpdate(); }, pollIntervalMs);
    heartbeatTimer = setIntervalFn(() => {
      broadcast(`: heartbeat ${Date.now()}\n\n`);
    }, heartbeatIntervalMs);
    pollTimer.unref?.();
    heartbeatTimer.unref?.();
  }

  function open(request, response) {
    if (closed) throw new Error('dashboard update broker is closed');
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();
    subscribers.add(response);
    safeWrite(response, 'retry: 5000\n\n');
    safeWrite(response, eventPayload('ready', {
      readOnly: true,
      connectedAt: new Date().toISOString(),
    }));
    const cleanup = () => remove(response);
    request.once('close', cleanup);
    response.once('close', cleanup);
    startTimers();
  }

  function close() {
    if (closed) return;
    closed = true;
    stopTimers();
    for (const response of [...subscribers]) {
      response.end();
    }
    subscribers.clear();
  }

  return Object.freeze({
    open,
    close,
    get subscriberCount() { return subscribers.size; },
    get timersActive() { return pollTimer !== null || heartbeatTimer !== null; },
    checkForUpdate,
  });
}
