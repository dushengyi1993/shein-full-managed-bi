#!/usr/bin/env node
/**
 * Captures the read-only product index for one full-managed store.
 *
 * The product page needs goods level, platform labels, price/supply price,
 * shelf status/time and per-site coverage, none of which the OpenAPI surface
 * exposes. This collector pages the three verified supplier-backoffice
 * endpoints through the same encrypted WebAPI session the order-management
 * index uses, projects only allowlisted fields and writes the index atomically.
 *
 * Plan mode is the default: it performs the capture and prints the summary but
 * does not write. `--execute` writes the index file.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { FULL_MANAGED_STORE_CODES } from '../src/config/full-managed-stores.mjs';
import {
  PRODUCT_INDEX_ENDPOINTS,
  PRODUCT_INDEX_MAX_PAGES,
  PRODUCT_INDEX_TRANSPORT_LIMITS,
  PRODUCT_INDEX_WEBAPI_ORIGIN,
  productIndexEndpointUrl,
  productIndexRequestBody,
  productIndexRequestQuery,
  productIndexRows,
  productIndexSiteStatusBody,
  productIndexTotal,
  readPath,
} from '../src/webapi-history/product-index-contracts.mjs';
import { buildProductIndex } from '../src/webapi-history/product-index.mjs';
import {
  cookieHeaderForUrl,
  mergeSetCookieHeaders,
  responseSetCookieHeaders,
} from '../src/webapi-session/cookie-jar.mjs';
import {
  createEncryptedWebApiSessionStoreFromEnvironment,
  normalizeWebApiSessionBundle,
} from '../src/webapi-session/encrypted-session-store.mjs';

const REFERER = `${PRODUCT_INDEX_WEBAPI_ORIGIN}/#/spmp/commdties/list`;

export class ProductIndexCaptureError extends Error {
  constructor(code) {
    super(`product-index capture refused: ${code}`);
    this.name = 'ProductIndexCaptureError';
    this.code = code;
  }
}

function fail(code) {
  throw new ProductIndexCaptureError(code);
}

function stableJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function platformFailure(body) {
  const record = body && typeof body === 'object' ? body : {};
  const code = String(record.code ?? '');
  return code === '0' ? null : (code || 'NONZERO_PLATFORM_CODE');
}

/**
 * Opens one store's session and returns a request function plus a close hook.
 * Every call re-reads the cookie header so a rotated cookie is honoured, and any
 * Set-Cookie is merged back into the encrypted bundle.
 */
export async function openProductIndexSession({
  storeCode,
  sessionStore,
  fetchImpl = fetch,
  clock = () => new Date(),
  limits = PRODUCT_INDEX_TRANSPORT_LIMITS,
} = {}) {
  if (!sessionStore || typeof sessionStore.read !== 'function' || typeof sessionStore.write !== 'function') {
    fail('PRODUCT_INDEX_SESSION_STORE_MISSING');
  }
  // Reject a store outside the roster before touching the session store, so an
  // invalid request cannot surface as an opaque session-store error.
  const canonical = assertRoster(storeCode);
  let bundle = normalizeWebApiSessionBundle(await sessionStore.read(canonical), canonical);
  let commitQueue = Promise.resolve();
  let closed = false;

  function enqueueBundleUpdate(update) {
    commitQueue = commitQueue.then(async () => {
      bundle = normalizeWebApiSessionBundle(await update(bundle), canonical);
      // Persist the rotated cookie set; dropping it here would silently keep
      // using a stale session until the next capture reads it again.
      await sessionStore.write(canonical, bundle);
    });
    return commitQueue;
  }

  async function request(endpointCode, { body, query = '', method } = {}) {
    if (closed) fail('PRODUCT_INDEX_SESSION_CLOSED');
    const endpoint = PRODUCT_INDEX_ENDPOINTS[String(endpointCode ?? '')];
    if (!endpoint) fail('PRODUCT_INDEX_ENDPOINT_NOT_ALLOWED');
    const verb = method ?? endpoint.method;
    const url = `${productIndexEndpointUrl(endpointCode)}${query ? `?${query}` : ''}`;
    const cookieHeader = cookieHeaderForUrl(bundle, url, clock());
    if (!cookieHeader) fail('PRODUCT_INDEX_AUTH_EXPIRED');
    const headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: PRODUCT_INDEX_WEBAPI_ORIGIN,
      Referer: REFERER,
      'User-Agent': bundle.userAgent,
      Cookie: cookieHeader,
    };
    const init = {
      method: verb,
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    };
    if (verb !== 'GET' && body !== undefined) {
      headers['Content-Type'] = 'application/json;Charset=utf-8';
      init.body = stableJson(body);
    }
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      fail('PRODUCT_INDEX_FETCH_FAILED');
    }
    const setCookieValues = responseSetCookieHeaders(response.headers);
    if (setCookieValues.length > 0) {
      await enqueueBundleUpdate((current) => mergeSetCookieHeaders(current, url, setCookieValues, clock()));
    }
    if ([301, 302, 303, 307, 308, 401, 403].includes(response.status)) {
      fail('PRODUCT_INDEX_AUTH_EXPIRED');
    }
    if (!response.ok) fail(`PRODUCT_INDEX_HTTP_${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limits.maxResponseBytes) {
      fail('PRODUCT_INDEX_RESPONSE_TOO_LARGE');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('PRODUCT_INDEX_RESPONSE_NOT_JSON');
    }
    const platformCode = platformFailure(parsed);
    if (platformCode) fail(`PRODUCT_INDEX_PLATFORM_${platformCode}`);
    return parsed;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await commitQueue;
  }

  return { request, close };
}

function assertRoster(storeCode) {
  const canonical = String(storeCode ?? '').trim().toUpperCase();
  if (!FULL_MANAGED_STORE_CODES.includes(canonical)) fail('PRODUCT_INDEX_STORE_NOT_IN_ROSTER');
  return canonical;
}

/** Pages one endpoint to completion, refusing a partial sweep. */
export async function pageEndpoint(request, endpointCode, { pageSize } = {}) {
  const endpoint = PRODUCT_INDEX_ENDPOINTS[endpointCode];
  const rows = [];
  let total = null;
  let firstPayload = null;
  for (let page = 1; page <= PRODUCT_INDEX_MAX_PAGES; page += 1) {
    const body = productIndexRequestBody(endpointCode, { page, pageSize });
    const query = productIndexRequestQuery(endpointCode, { page, pageSize });
    const payload = await request(endpointCode, { body, query });
    if (firstPayload === null) firstPayload = payload;
    const pageRows = productIndexRows(endpointCode, payload);
    const pageTotal = productIndexTotal(endpointCode, payload);
    if (pageTotal !== null) total = pageTotal;
    rows.push(...pageRows);
    if (pageRows.length === 0) break;
    if (total !== null && rows.length >= total) break;
    if (pageRows.length < (pageSize ?? endpoint.defaultPageSize)) break;
  }
  if (total !== null && rows.length < total) fail('PRODUCT_INDEX_PAGING_INCOMPLETE');
  return { rows, total: total ?? rows.length, firstPayload };
}

async function fetchAllSiteStatus(request, skcNames) {
  const result = {};
  const batch = 100;
  for (let offset = 0; offset < skcNames.length; offset += batch) {
    const slice = skcNames.slice(offset, offset + batch);
    if (slice.length === 0) break;
    const body = productIndexSiteStatusBody(slice);
    const payload = await request('SITE_STATUS', { body });
    for (const row of productIndexRows('SITE_STATUS', payload)) {
      const skcName = String(row?.skc_name ?? '').trim();
      if (!skcName) continue;
      result[skcName] = Array.isArray(row.site_status_list) ? row.site_status_list : [];
    }
  }
  return result;
}

export async function captureProductIndex({
  storeCode,
  sessionStore,
  fetchImpl = fetch,
  clock = () => new Date(),
} = {}) {
  const canonical = assertRoster(storeCode);
  const session = await openProductIndexSession({ storeCode: canonical, sessionStore, fetchImpl, clock });
  try {
    const list = await pageEndpoint(session.request, 'PRODUCT_LIST', { pageSize: 100 });
    const goods = await pageEndpoint(session.request, 'GOODS_SKC_LIST', { pageSize: 100 });
    const statusCounts = readPath(list.firstPayload, PRODUCT_INDEX_ENDPOINTS.PRODUCT_LIST.statusCountsPath);
    const skcNames = goods.rows.map((row) => String(row?.skc ?? '').trim()).filter(Boolean);
    const siteStatus = skcNames.length > 0 ? await fetchAllSiteStatus(session.request, skcNames) : {};
    const index = buildProductIndex({
      productListRows: list.rows,
      goodsSkcRows: goods.rows,
      siteStatus,
      shelfStatusCounts: Array.isArray(statusCounts) ? statusCounts : [],
      storeCode: canonical,
      capturedAt: clock().toISOString(),
    });
    return { index, summary: { storeCode: canonical, products: list.total, skcs: goods.total, siteCoverage: Object.keys(siteStatus).length } };
  } finally {
    await session.close();
  }
}

function parseFlags(argv) {
  const flags = { execute: false, store: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--execute') flags.execute = true;
    else if (arg === '--store') flags.store = argv[++i] ?? '';
    else if (arg === '--out') flags.out = argv[++i] ?? '';
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.store) {
    process.stderr.write('usage: capture_full_managed_product_index.mjs --store <CODE> [--out <file>] [--execute]\n');
    process.exitCode = 2;
    return;
  }
  const sessionStore = await createEncryptedWebApiSessionStoreFromEnvironment();
  const { index, summary } = await captureProductIndex({ storeCode: flags.store, sessionStore });
  const outFile = flags.out || `/srv/shein-fm/runtime/dashboard/product-index-${summary.storeCode}.json`;
  if (flags.execute) {
    await mkdir(path.dirname(outFile), { recursive: true });
    const tmp = `${outFile}.tmp`;
    await writeFile(tmp, JSON.stringify(index), 'utf8');
    await rename(tmp, outFile);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode: flags.execute ? 'execute' : 'plan', out: flags.execute ? outFile : null, ...summary })}\n`);
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode: String(error?.code ?? 'PRODUCT_INDEX_CAPTURE_FAILED') })}\n`);
    process.exitCode = 1;
  });
}
