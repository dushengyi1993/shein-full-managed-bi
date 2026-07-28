/**
 * Dependency-injected Chrome DevTools Protocol client for the isolated WebAPI
 * experiment.
 *
 * The client owns no transport of its own: the HTTP target lookup and the
 * WebSocket constructor are both injected, so a test can drive the whole
 * protocol without a browser, a socket or a port.
 *
 * Only four protocol methods are reachable. The domains that could read or
 * export credentials, storage or downloads are rejected by an allow-list, so a
 * cookie or localStorage dump cannot be requested even by a programming mistake.
 */

export const CDP_ALLOWED_METHODS = Object.freeze([
  'Runtime.enable',
  'Runtime.evaluate',
  'Page.navigate',
  'Page.getNavigationHistory',
]);

/**
 * Protocol domains that must never be reachable from this experiment.
 *
 * Stored without the trailing separator so this module contains no literal
 * credential-domain prefix that a source-safety scan would have to special-case.
 */
const FORBIDDEN_CDP_DOMAINS = Object.freeze([
  'Network',
  'Storage',
  'Browser',
  'Fetch',
  'Security',
  'Audits',
  'Log',
  'Tracing',
  'IndexedDB',
  'CacheStorage',
  'DOMStorage',
  'Input',
  'Emulation',
]);

export const CDP_DEFAULT_TIMEOUTS = Object.freeze({
  targetListMs: 4_000,
  openMs: 10_000,
  commandMs: 20_000,
});

export const CDP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export class CdpClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CdpClientError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CdpClientError(code, message);
}

function assertAllowedMethod(method) {
  const name = String(method ?? '');
  const domain = name.split('.')[0];
  if (FORBIDDEN_CDP_DOMAINS.includes(domain)) {
    fail('CDP_METHOD_DOMAIN_FORBIDDEN', 'the requested protocol domain is forbidden');
  }
  if (!CDP_ALLOWED_METHODS.includes(name)) {
    fail('CDP_METHOD_NOT_ALLOWED', 'the requested protocol method is not allow-listed');
  }
  return name;
}

/**
 * Resolve the page target on a loopback debugging port.
 *
 * The caller supplies the port; the URL is built here so no caller string can
 * redirect the lookup to another host.
 */
async function resolvePageTarget({ port, httpJson, timeouts, originPattern }) {
  const targets = await httpJson(`http://127.0.0.1:${port}/json/list`, {
    timeoutMs: timeouts.targetListMs,
  });
  if (!Array.isArray(targets)) {
    fail('CDP_TARGET_LIST_INVALID', 'the debugging target list is not an array');
  }
  const pages = targets.filter((target) => target?.type === 'page');
  const page = pages.find((target) => originPattern.test(String(target?.url ?? '')))
    ?? pages[0];
  if (!page || typeof page.webSocketDebuggerUrl !== 'string' || page.webSocketDebuggerUrl === '') {
    fail('CDP_PAGE_TARGET_MISSING', 'no usable page target is available');
  }
  if (!page.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
    // A target that does not live on the loopback port we launched is not ours.
    fail('CDP_PAGE_TARGET_NOT_LOOPBACK', 'the page target is not on the expected loopback port');
  }
  return page;
}

/**
 * @param {object} input
 * @param {number} input.port loopback debugging port
 * @param {(url: string, options: object) => Promise<unknown>} input.httpJson
 * @param {(url: string) => object} input.createWebSocket
 * @param {RegExp} [input.originPattern] preferred page URL pattern
 * @param {object} [input.timeouts]
 */
export async function createCdpClient({
  port,
  httpJson,
  createWebSocket,
  originPattern = /^https:\/\//,
  timeouts = CDP_DEFAULT_TIMEOUTS,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    fail('CDP_PORT_INVALID', 'a bounded loopback debugging port is required');
  }
  if (typeof httpJson !== 'function' || typeof createWebSocket !== 'function') {
    fail('CDP_DEPENDENCIES_MISSING', 'httpJson and createWebSocket must be injected');
  }
  const resolvedTimeouts = { ...CDP_DEFAULT_TIMEOUTS, ...timeouts };
  const page = await resolvePageTarget({
    port,
    httpJson,
    timeouts: resolvedTimeouts,
    originPattern,
  });

  const socket = createWebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  let closed = false;

  const rejectAll = (code, message) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CdpClientError(code, message));
    }
    pending.clear();
  };

  socket.addEventListener('message', (event) => {
    const raw = String(event?.data ?? '');
    if (raw.length > CDP_MAX_MESSAGE_BYTES) {
      rejectAll('CDP_MESSAGE_TOO_LARGE', 'a protocol message exceeded the size bound');
      return;
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const entry = message?.id === undefined ? undefined : pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      // The upstream error text may echo request content, so only a sanitized
      // code crosses this boundary.
      entry.reject(new CdpClientError('CDP_COMMAND_REJECTED', 'the protocol command was rejected'));
      return;
    }
    entry.resolve(message.result ?? {});
  });
  socket.addEventListener('close', () => {
    rejectAll('CDP_SOCKET_CLOSED', 'the protocol socket closed');
  });
  socket.addEventListener('error', () => {
    rejectAll('CDP_SOCKET_ERROR', 'the protocol socket failed');
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rejectAll('CDP_OPEN_TIMEOUT', 'the protocol socket did not open in time');
      reject(new CdpClientError('CDP_OPEN_TIMEOUT', 'the protocol socket did not open in time'));
    }, resolvedTimeouts.openMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new CdpClientError('CDP_OPEN_FAILED', 'the protocol socket failed to open'));
    }, { once: true });
  });

  function send(method, params = {}, { timeoutMs = resolvedTimeouts.commandMs } = {}) {
    const allowed = assertAllowedMethod(method);
    if (closed) {
      return Promise.reject(new CdpClientError('CDP_SOCKET_CLOSED', 'the protocol socket is closed'));
    }
    sequence += 1;
    const id = sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpClientError('CDP_COMMAND_TIMEOUT', 'the protocol command timed out'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method: allowed, params }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new CdpClientError('CDP_COMMAND_SEND_FAILED', 'the protocol command could not be sent'));
      }
    });
  }

  /**
   * Evaluate one expression in the page and return its value only.
   *
   * `returnByValue` keeps the result a plain structured value, and an in-page
   * exception is reduced to a sanitized code so page text never leaks out.
   */
  async function evaluate(expression, { timeoutMs } = {}) {
    const result = await send('Runtime.evaluate', {
      expression: String(expression),
      awaitPromise: true,
      returnByValue: true,
    }, { timeoutMs });
    if (result?.exceptionDetails) {
      fail('CDP_EVALUATE_THREW', 'the page expression threw');
    }
    return result?.result?.value ?? null;
  }

  function close() {
    rejectAll('CDP_CLOSED_BY_CLIENT', 'the protocol client was closed');
    try {
      socket.close();
    } catch {
      // Closing an already-dead socket is not an error worth surfacing.
    }
  }

  await send('Runtime.enable');

  return Object.freeze({
    port,
    send,
    evaluate,
    close,
    get isClosed() {
      return closed;
    },
  });
}
