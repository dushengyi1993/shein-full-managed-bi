import { normalizeWebApiSessionBundle } from './encrypted-session-store.mjs';

const MAX_SET_COOKIE_HEADERS = 128;

function canonicalHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function cookieDomain(cookie) {
  return canonicalHost(cookie?.domain).replace(/^\./, '');
}

function domainMatches(cookie, host) {
  const domain = cookieDomain(cookie);
  if (!domain) return false;
  if (cookie?.hostOnly === true) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(cookiePath, requestPath) {
  const candidate = String(cookiePath || '/');
  if (candidate === '/') return true;
  if (!requestPath.startsWith(candidate)) return false;
  return candidate.endsWith('/')
    || requestPath.length === candidate.length
    || requestPath[candidate.length] === '/';
}

function cookieExpired(cookie, nowSeconds) {
  return Number.isFinite(cookie?.expires)
    && cookie.expires > 0
    && cookie.expires <= nowSeconds;
}

function cookieKey(cookie) {
  return `${String(cookie.name)}\u0000${canonicalHost(cookie.domain)}\u0000${String(cookie.path || '/')}`;
}

function defaultCookiePath(requestPath) {
  const pathname = String(requestPath || '/');
  if (!pathname.startsWith('/') || pathname === '/') return '/';
  const slash = pathname.lastIndexOf('/');
  return slash <= 0 ? '/' : pathname.slice(0, slash);
}

function splitSetCookieHeader(value) {
  const text = String(value ?? '');
  if (!text) return [];
  const result = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < text.length; index += 1) {
    const lower = text.slice(index, index + 8).toLowerCase();
    if (lower === 'expires=') inExpires = true;
    if (text[index] === ';') inExpires = false;
    if (text[index] === ',' && !inExpires) {
      const remainder = text.slice(index + 1);
      if (/^\s*[^=;,\s]+\s*=/.test(remainder)) {
        result.push(text.slice(start, index).trim());
        start = index + 1;
      }
    }
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

export function responseSetCookieHeaders(headers) {
  if (!headers) return Object.freeze([]);
  let values = [];
  if (typeof headers.getSetCookie === 'function') {
    values = headers.getSetCookie();
  } else if (typeof headers.raw === 'function') {
    values = headers.raw()?.['set-cookie'] ?? [];
  } else if (typeof headers.get === 'function') {
    values = splitSetCookieHeader(headers.get('set-cookie'));
  }
  if (!Array.isArray(values) || values.length > MAX_SET_COOKIE_HEADERS) return Object.freeze([]);
  return Object.freeze(values.map(String).filter(Boolean));
}

function parseSetCookie(value, requestUrl, nowSeconds) {
  const parts = String(value ?? '').split(';');
  const first = parts.shift()?.trim() ?? '';
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  const name = first.slice(0, separator).trim();
  const cookieValue = first.slice(separator + 1);
  if (!name) return null;
  const url = new URL(requestUrl);
  const candidate = {
    name,
    value: cookieValue,
    domain: url.hostname,
    path: defaultCookiePath(url.pathname),
    expires: null,
    httpOnly: false,
    secure: false,
    sameSite: null,
    hostOnly: true,
  };
  let remove = false;
  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim();
    if (!attribute) continue;
    const equals = attribute.indexOf('=');
    const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const attributeValue = equals === -1 ? '' : attribute.slice(equals + 1).trim();
    if (key === 'domain') {
      const domain = canonicalHost(attributeValue).replace(/^\./, '');
      if (!domain || !(url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
      candidate.domain = attributeValue.startsWith('.') ? `.${domain}` : domain;
      candidate.hostOnly = false;
    } else if (key === 'path') {
      candidate.path = attributeValue.startsWith('/') ? attributeValue : '/';
    } else if (key === 'max-age') {
      const seconds = Number(attributeValue);
      if (Number.isFinite(seconds)) {
        candidate.expires = nowSeconds + seconds;
        if (seconds <= 0) remove = true;
      }
    } else if (key === 'expires' && candidate.expires === null) {
      const milliseconds = Date.parse(attributeValue);
      if (Number.isFinite(milliseconds)) {
        candidate.expires = milliseconds / 1000;
        if (candidate.expires <= nowSeconds) remove = true;
      }
    } else if (key === 'secure') candidate.secure = true;
    else if (key === 'httponly') candidate.httpOnly = true;
    else if (key === 'samesite') {
      const sameSite = attributeValue.toLowerCase();
      candidate.sameSite = sameSite === 'strict'
        ? 'Strict'
        : sameSite === 'lax'
          ? 'Lax'
          : sameSite === 'none'
            ? 'None'
            : null;
    }
  }
  return { cookie: candidate, remove };
}

export function cookieHeaderForUrl(bundle, requestUrl, now = new Date()) {
  const normalized = normalizeWebApiSessionBundle(bundle, bundle?.storeCode);
  const url = new URL(requestUrl);
  const nowSeconds = now.valueOf() / 1000;
  return normalized.cookies
    .filter((cookie) => !cookieExpired(cookie, nowSeconds))
    .filter((cookie) => domainMatches(cookie, canonicalHost(url.hostname)))
    .filter((cookie) => pathMatches(cookie.path, url.pathname || '/'))
    .filter((cookie) => cookie.secure !== true || url.protocol === 'https:')
    .sort((left, right) => right.path.length - left.path.length || left.order - right.order)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function mergeSetCookieHeaders(bundle, requestUrl, values, now = new Date()) {
  const normalized = normalizeWebApiSessionBundle(bundle, bundle?.storeCode);
  const nowSeconds = now.valueOf() / 1000;
  const jar = new Map(
    normalized.cookies
      .filter((cookie) => !cookieExpired(cookie, nowSeconds))
      .map((cookie) => [cookieKey(cookie), { ...cookie }]),
  );
  for (const value of Array.isArray(values) ? values.slice(0, MAX_SET_COOKIE_HEADERS) : []) {
    const parsed = parseSetCookie(value, requestUrl, nowSeconds);
    if (!parsed) continue;
    const key = cookieKey(parsed.cookie);
    if (parsed.remove) jar.delete(key);
    else jar.set(key, { ...parsed.cookie, order: jar.get(key)?.order ?? jar.size });
  }
  return normalizeWebApiSessionBundle({
    ...normalized,
    updatedAt: now.toISOString(),
    cookies: [...jar.values()],
  }, normalized.storeCode);
}

export function sessionExpirySummary(bundle, now = new Date()) {
  const normalized = normalizeWebApiSessionBundle(bundle, bundle?.storeCode);
  const nowSeconds = now.valueOf() / 1000;
  const future = normalized.cookies
    .map(({ expires }) => expires)
    .filter((expires) => Number.isFinite(expires) && expires > nowSeconds)
    .sort((left, right) => left - right);
  return Object.freeze({
    storeCode: normalized.storeCode,
    activeCookieCount: normalized.cookies.filter((cookie) => !cookieExpired(cookie, nowSeconds)).length,
    earliestExpiresAt: future.length ? new Date(future[0] * 1000).toISOString() : null,
    latestExpiresAt: future.length ? new Date(future.at(-1) * 1000).toISOString() : null,
  });
}
