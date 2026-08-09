import { readFile, stat } from 'node:fs/promises';

import {
  ORDER_MANAGEMENT_PAGE_IDS,
  containsNumericPii,
  validateOrderManagementIndex,
  validateOrderManagementRow,
} from '../order-management/order-management-contract.mjs';

export { ORDER_MANAGEMENT_PAGE_IDS } from '../order-management/order-management-contract.mjs';

const CACHE = new Map();
const STORE_CODE_PATTERN = /^[A-Z0-9]{2,12}$/;

export class OrderManagementDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OrderManagementDataError';
    this.code = code;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCoverage(value) {
  const source = record(value);
  const storeCodes = Object.freeze([...new Set(rows(source.storeCodes))]);
  return Object.freeze({
    status: source.status,
    expectedStoreCount: source.expectedStoreCount ?? null,
    completedStoreCount: source.completedStoreCount ?? 0,
    storeCodes,
    reason: source.reason ?? null,
  });
}

function normalizePageCoverage(source, pageId, page, globalCoverage) {
  const evidence = record(record(record(source.evidence).pages)[pageId]);
  const storeCodes = Object.freeze([...new Set(rows(evidence.storeCodes)
    .map((value) => String(value ?? '').trim().toUpperCase())
    .filter((value) => STORE_CODE_PATTERN.test(value)))].sort());
  const expectedStoreCount = globalCoverage.expectedStoreCount;
  const completedStoreCount = storeCodes.length;
  const status = page.status === 'UNAVAILABLE'
    ? 'UNAVAILABLE'
    : page.status === 'AVAILABLE'
      && Number.isSafeInteger(expectedStoreCount)
      && completedStoreCount === expectedStoreCount
      ? 'COMPLETE'
      : 'PARTIAL';
  return Object.freeze({
    status,
    expectedStoreCount,
    completedStoreCount,
    storeCodes,
    reason: page.reason ?? null,
  });
}

// 共享契约已校验整份索引（含 metrics/facts/details 的字段 allowlist、
// 拒绝 PII 标签键名与数值 PII）。此处再对 tags 做第二道数值 PII 防线：
// 命中即拒绝整行并把页面降级为 PARTIAL，绝不转发。
function normalizePage(pageId, page) {
  let rejectedPii = 0;
  const keptRows = [];
  for (const candidate of rows(page.rows)) {
    const rowVerdict = validateOrderManagementRow(candidate, { pageId });
    const tagsCarryPii = rows(candidate?.tags ?? []).some((tag) => containsNumericPii(tag));
    if (!rowVerdict.ok || tagsCarryPii) {
      rejectedPii += 1;
      continue;
    }
    keptRows.push(Object.freeze({ ...record(candidate) }));
  }
  let status = page.status;
  let reason = page.reason ?? null;
  if (rejectedPii > 0) {
    status = 'PARTIAL';
    reason = reason
      ? `${reason}; ROWS_REJECTED_PII:${rejectedPii}`
      : `ROWS_REJECTED_PII:${rejectedPii}`;
  }
  return Object.freeze({
    status,
    source: page.source,
    latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
    reason,
    rows: Object.freeze(keptRows),
  });
}

function normalizeOrderManagementIndex(value) {
  const source = record(value);
  if (source.schemaVersion !== 1) {
    throw new OrderManagementDataError('ORDER_MANAGEMENT_SCHEMA_UNSUPPORTED', '订单管理索引版本不受支持');
  }
  const verdict = validateOrderManagementIndex(source);
  if (!verdict.ok) {
    throw new OrderManagementDataError(
      'ORDER_MANAGEMENT_SCHEMA_INVALID',
      `订单管理索引不合法: ${verdict.errors.slice(0, 8).join('; ')}`,
    );
  }
  const pages = {};
  for (const pageId of ORDER_MANAGEMENT_PAGE_IDS) {
    pages[pageId] = normalizePage(pageId, source.pages[pageId]);
  }
  const coverage = normalizeCoverage(source.coverage);
  const pageCoverage = {};
  for (const pageId of ORDER_MANAGEMENT_PAGE_IDS) {
    pageCoverage[pageId] = normalizePageCoverage(source, pageId, pages[pageId], coverage);
  }
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: source.updatedAt,
    promotable: source.promotable,
    coverage,
    pageCoverage: Object.freeze(pageCoverage),
    pages: Object.freeze(pages),
  });
}

export async function loadOrderManagementData(
  file = process.env.FULL_BI_ORDER_MANAGEMENT_FILE,
  { runtimeEnvironment = process.env.NODE_ENV || 'development', forceRefresh = false } = {},
) {
  if (!file && String(runtimeEnvironment).toLowerCase() === 'production') {
    throw new OrderManagementDataError(
      'ORDER_MANAGEMENT_FILE_REQUIRED',
      'FULL_BI_ORDER_MANAGEMENT_FILE is required in production',
    );
  }
  if (!file) {
    // 开发环境没有显式文件时返回空索引（不伪造任何业务数据），
    // 任何页面查询都会以 UNAVAILABLE fail closed。
    return Object.freeze({
      schemaVersion: 1,
      updatedAt: null,
      promotable: false,
      coverage: Object.freeze({
        status: 'UNAVAILABLE',
        expectedStoreCount: null,
        completedStoreCount: 0,
        storeCodes: Object.freeze([]),
        reason: 'ORDER_MANAGEMENT_FILE_NOT_CONFIGURED',
      }),
      pageCoverage: Object.freeze({}),
      pages: Object.freeze({}),
    });
  }
  const metadata = await stat(file);
  const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
  const cached = CACHE.get(file);
  if (!forceRefresh && cached?.signature === signature && cached.value) return cached.value;
  if (cached?.signature === signature && cached.promise) return cached.promise;
  const promise = readFile(file, 'utf8')
    .then((body) => normalizeOrderManagementIndex(JSON.parse(body)))
    .then((normalized) => {
      CACHE.set(file, { signature, value: normalized });
      return normalized;
    })
    .catch((error) => {
      if (CACHE.get(file)?.promise === promise) CACHE.delete(file);
      throw error;
    });
  CACHE.set(file, { signature, promise });
  return promise;
}
