import {
  HOME_ENDPOINTS,
  HOME_WEBAPI_ORIGIN,
  endpointUrl,
} from '../webapi-history/home-contracts.mjs';
import { STORE_RUNTIME_SLOTS } from '../webapi-experiment/browser-session.mjs';
import { normalizeWebApiSessionBundle } from './encrypted-session-store.mjs';

const EXPORT_TIMEOUT_MS = 15_000;
const MAX_TARGET_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROTOCOL_RESPONSE_BYTES = 4 * 1024 * 1024;

export class WebApiSessionExportError extends Error {
  constructor(code) {
    super(`WebAPI session export refused: ${code}`);
    this.name = 'WebApiSessionExportError';
    this.code = code;
  }
}

function fail(code) {
  throw new WebApiSessionExportError(code);
}

function loopbackTargetListUrl(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    fail('WEBAPI_SESSION_EXPORT_PORT_INVALID');
  }
  return `http://127.0.0.1:${port}/json/list`;
}

async function targetList(port, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(loopbackTargetListUrl(port), {
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    fail('WEBAPI_SESSION_EXPORT_TARGET_UNAVAILABLE');
  }
  if (!response?.ok) fail('WEBAPI_SESSION_EXPORT_TARGET_UNAVAILABLE');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_TARGET_RESPONSE_BYTES) {
    fail('WEBAPI_SESSION_EXPORT_TARGET_INVALID');
  }
  let targets;
  try {
    targets = JSON.parse(text);
  } catch {
    fail('WEBAPI_SESSION_EXPORT_TARGET_INVALID');
  }
  if (!Array.isArray(targets)) fail('WEBAPI_SESSION_EXPORT_TARGET_INVALID');
  return targets;
}

async function pageSocketUrl(port, fetchImpl) {
  const targets = await targetList(port, fetchImpl);
  const page = targets.find((target) => (
    target?.type === 'page'
    && String(target?.url ?? '').startsWith(`${HOME_WEBAPI_ORIGIN}/`)
  ));
  const socketUrl = String(page?.webSocketDebuggerUrl ?? '');
  if (!socketUrl.startsWith(`ws://127.0.0.1:${port}/`)) {
    fail('WEBAPI_SESSION_EXPORT_TARGET_INVALID');
  }
  return socketUrl;
}

async function getOriginCookies({ socketUrl, createWebSocket, timeoutMs = EXPORT_TIMEOUT_MS }) {
  const socket = createWebSocket(socketUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new WebApiSessionExportError('WEBAPI_SESSION_EXPORT_TIMEOUT'));
    }, timeoutMs);
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({
          id: 1,
          method: 'Network.getCookies',
          params: {
            urls: Object.keys(HOME_ENDPOINTS).map(endpointUrl),
          },
        }));
      } catch {
        finish(new WebApiSessionExportError('WEBAPI_SESSION_EXPORT_SEND_FAILED'));
      }
    }, { once: true });
    socket.addEventListener('message', (event) => {
      const raw = String(event?.data ?? '');
      if (Buffer.byteLength(raw, 'utf8') > MAX_PROTOCOL_RESPONSE_BYTES) {
        finish(new WebApiSessionExportError('WEBAPI_SESSION_EXPORT_RESPONSE_TOO_LARGE'));
        return;
      }
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message?.id !== 1) return;
      if (message.error || !Array.isArray(message?.result?.cookies)) {
        finish(new WebApiSessionExportError('WEBAPI_SESSION_EXPORT_COMMAND_FAILED'));
        return;
      }
      finish(null, message.result.cookies);
    });
    socket.addEventListener('error', () => {
      finish(new WebApiSessionExportError('WEBAPI_SESSION_EXPORT_SOCKET_FAILED'));
    }, { once: true });
    socket.addEventListener('close', () => {
      if (!settled) finish(new WebApiSessionExportError('WEBAPI_SESSION_EXPORT_SOCKET_CLOSED'));
    }, { once: true });
  });
}

export async function exportAuthenticatedWebApiSession({
  session,
  storeCode,
  fetchImpl = fetch,
  createWebSocket = (url) => new WebSocket(url),
  clock = () => new Date(),
} = {}) {
  const canonical = String(storeCode ?? '').trim().toUpperCase();
  if (
    !session
    || session.storeCode !== canonical
    || session.identityProven !== true
    || typeof session.evaluate !== 'function'
  ) fail('WEBAPI_SESSION_EXPORT_IDENTITY_UNPROVEN');
  const slot = STORE_RUNTIME_SLOTS[canonical];
  if (!slot) fail('WEBAPI_SESSION_EXPORT_STORE_NOT_ALLOWED');
  const userAgent = await session.evaluate('String(navigator.userAgent || "")', {
    timeoutMs: 5_000,
  }).catch(() => fail('WEBAPI_SESSION_EXPORT_USER_AGENT_FAILED'));
  const socketUrl = await pageSocketUrl(slot.debuggingPort, fetchImpl);
  const cookies = await getOriginCookies({ socketUrl, createWebSocket });
  const now = clock();
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return normalizeWebApiSessionBundle({
    version: 1,
    storeCode: canonical,
    origin: HOME_WEBAPI_ORIGIN,
    userAgent,
    createdAt: timestamp,
    updatedAt: timestamp,
    identityProvenAt: timestamp,
    lastVerifiedAt: null,
    cookies,
  }, canonical);
}
