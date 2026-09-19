import { readFile, stat } from 'node:fs/promises';

import {
  PRODUCT_PRIORITY_SITE_CODES,
  PRODUCT_INDEX_VERSION,
} from '../webapi-history/product-index.mjs';

export { PRODUCT_PRIORITY_SITE_CODES } from '../webapi-history/product-index.mjs';

const CACHE = new Map();

export class ProductIndexDataError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ProductIndexDataError';
    this.code = code;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result === '' ? null : result;
}

function nullableInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeShelfStatusCounts(source) {
  const input = record(source);
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    result[String(key).toUpperCase()] = nullableInteger(value);
  }
  return Object.freeze(result);
}

function normalizeLevelGroupCounts(source) {
  const input = record(source);
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    result[String(key).toUpperCase()] = nullableInteger(value) ?? 0;
  }
  return Object.freeze(result);
}

function normalizeSiteEntry(value) {
  const source = record(value);
  return Object.freeze({
    siteCode: text(source.siteCode),
    shelfStatus: Number.isSafeInteger(source.shelfStatus) ? source.shelfStatus : null,
    shelfStatusLabel: text(source.shelfStatusLabel),
    sellBanStatus: Number.isSafeInteger(source.sellBanStatus) ? source.sellBanStatus : null,
    sellBanStatusLabel: text(source.sellBanStatusLabel),
  });
}

function normalizePriority(source) {
  const input = record(source);
  const result = {};
  for (const code of PRODUCT_PRIORITY_SITE_CODES) {
    const entry = record(input[code]);
    result[code] = Object.freeze({
      onSale: entry.onSale === true ? true : entry.onSale === false ? false : null,
      shelfStatus: Number.isSafeInteger(entry.shelfStatus) ? entry.shelfStatus : null,
      sellBanStatus: Number.isSafeInteger(entry.sellBanStatus) ? entry.sellBanStatus : null,
    });
  }
  return Object.freeze(result);
}

function normalizeSiteCoverage(source) {
  const result = {};
  for (const [skcName, value] of Object.entries(record(source))) {
    const entry = record(value);
    const sites = {};
    for (const [code, siteValue] of Object.entries(record(entry.sites))) {
      sites[code] = normalizeSiteEntry(siteValue);
    }
    result[skcName] = Object.freeze({
      skc: text(entry.skc) ?? skcName,
      siteCount: nullableInteger(entry.siteCount) ?? Object.keys(sites).length,
      sites: Object.freeze(sites),
      priority: normalizePriority(entry.priority),
    });
  }
  return Object.freeze(result);
}

function normalizeSku(value) {
  const source = record(value);
  return Object.freeze({
    skuCode: text(source.skuCode),
    supplierSku: text(source.supplierSku),
    attr: text(source.attr),
    price: Number.isFinite(source.price) ? source.price : null,
    finalPrice: Number.isFinite(source.finalPrice) ? source.finalPrice : null,
    purchasePrice: Number.isFinite(source.purchasePrice) ? source.purchasePrice : null,
    predictDaySales: Number.isFinite(source.predictDaySales) ? source.predictDaySales : null,
    totalSaleVolume: nullableInteger(source.totalSaleVolume),
    c7dSaleCnt: nullableInteger(source.c7dSaleCnt),
    c30dSaleCnt: nullableInteger(source.c30dSaleCnt),
    stock: nullableInteger(source.stock),
    stayDeliver: nullableInteger(source.stayDeliver),
    stayShelf: nullableInteger(source.stayShelf),
    transit: nullableInteger(source.transit),
    preemptionNum: nullableInteger(source.preemptionNum),
    supplierStock: nullableInteger(source.supplierStock),
    saleableStock: nullableInteger(source.saleableStock),
    stockSaleDays: Number.isFinite(source.stockSaleDays) ? source.stockSaleDays : null,
    saleDays: Number.isFinite(source.saleDays) ? source.saleDays : null,
    stockDays: Number.isFinite(source.stockDays) ? source.stockDays : null,
    virtualSign: nullableInteger(source.virtualSign),
  });
}

function normalizeSkc(value) {
  const source = record(value);
  return Object.freeze({
    skc: text(source.skc),
    spu: text(source.spu),
    supplierCode: text(source.supplierCode),
    categoryName: text(source.categoryName),
    picUrl: text(source.picUrl),
    shelfDays: nullableInteger(source.shelfDays),
    shelfDate: text(source.shelfDate),
    currencySymbol: text(source.currencySymbol),
    c7dSaleCntSum: nullableInteger(source.c7dSaleCntSum),
    goodsLevelName: text(source.goodsLevelName),
    goodsLevelGroup: text(source.goodsLevelGroup),
    goodsLevelNote: text(source.goodsLevelNote),
    goodsLevelCanOrder: source.goodsLevelCanOrder === true,
    labels: Object.freeze(rows(source.labels).map(text).filter(Boolean)),
    skus: Object.freeze(rows(source.skus).map(normalizeSku)),
  });
}

function normalizeProduct(value) {
  const source = record(value);
  return Object.freeze({
    spu: text(source.spu),
    spuName: text(source.spuName),
    productName: text(source.productName),
    productNameEn: text(source.productNameEn),
    categoryId: nullableInteger(source.categoryId),
    brandCode: text(source.brandCode),
    brandName: text(source.brandName),
    shelfStatus: text(source.shelfStatus),
    createdAt: text(source.createdAt),
    publishedAt: text(source.publishedAt),
    firstShelfAt: text(source.firstShelfAt),
    expectShelfAt: text(source.expectShelfAt),
    skcs: Object.freeze(rows(source.skcs).map((item) => {
      const skc = record(item);
      return Object.freeze({
        skcName: text(skc.skcName),
        skcCode: text(skc.skcCode),
        saleName: text(skc.saleName),
        supplierCode: text(skc.supplierCode),
        mainImageUrl: text(skc.mainImageUrl),
        businessModel: nullableInteger(skc.businessModel),
        mallSellStatus: nullableInteger(skc.mallSellStatus),
        abandoned: skc.abandoned === true,
        hasActivity: skc.hasActivity === true,
        hasOriginalImage: skc.hasOriginalImage === true,
        shelfFailReason: text(skc.shelfFailReason),
        skuCodes: Object.freeze(rows(skc.skuCodes).map(text).filter(Boolean)),
      });
    })),
  });
}

/**
 * Validates and normalizes a product index file.  A missing schemaVersion or a
 * non-object payload fails closed: the page must not render half-parsed data.
 */
export function normalizeProductIndex(payload) {
  const source = record(payload);
  if (source.schemaVersion !== PRODUCT_INDEX_VERSION) {
    throw new ProductIndexDataError('PRODUCT_INDEX_SCHEMA_UNSUPPORTED', '商品索引版本不受支持');
  }
  const levelGroupCounts = normalizeLevelGroupCounts(source.levelGroupCounts);
  return Object.freeze({
    schemaVersion: PRODUCT_INDEX_VERSION,
    storeCode: text(source.storeCode),
    capturedAt: text(source.capturedAt),
    shelfStatusCounts: normalizeShelfStatusCounts(source.shelfStatusCounts),
    levelGroupCounts,
    productCount: nullableInteger(source.productCount) ?? 0,
    skcCount: nullableInteger(source.skcCount) ?? 0,
    siteCoverageCount: nullableInteger(source.siteCoverageCount) ?? 0,
    products: Object.freeze(rows(source.products).map(normalizeProduct)),
    skcs: Object.freeze(rows(source.skcs).map(normalizeSkc)),
    siteCoverage: normalizeSiteCoverage(source.siteCoverage),
  });
}

function fileCacheKey(filePath) {
  return String(filePath ?? '');
}

/**
 * Loads the product index from disk with an mtime/size cache, mirroring the
 * order-management loader.  A missing file is reported as unavailable rather
 * than as an empty index, so an absent capture is never shown as zero products.
 */
export async function loadProductIndexData(filePath, { forceRefresh = false } = {}) {
  const resolved = text(filePath);
  if (!resolved) {
    throw new ProductIndexDataError('PRODUCT_INDEX_FILE_MISSING', '商品索引文件未配置');
  }
  let stats;
  try {
    stats = await stat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ProductIndexDataError('PRODUCT_INDEX_FILE_MISSING', '商品索引文件不存在');
    }
    throw error;
  }
  const key = fileCacheKey(resolved);
  const cached = CACHE.get(key);
  if (!forceRefresh && cached
      && cached.mtimeMs === stats.mtimeMs
      && cached.size === stats.size) {
    return cached.index;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProductIndexDataError('PRODUCT_INDEX_FILE_INVALID', '商品索引文件无法解析');
    }
    throw error;
  }
  const index = normalizeProductIndex(parsed);
  CACHE.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, index });
  return index;
}

export function clearProductIndexCache() {
  CACHE.clear();
}
