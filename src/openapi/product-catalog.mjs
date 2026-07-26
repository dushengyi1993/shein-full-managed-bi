import { SheinOpenApiError } from './shein-client.mjs';
import {
  fetchPageSequence,
  payloadFingerprint,
  requirePositiveInteger,
} from './paginated-fetch.mjs';

export const PRODUCT_QUERY_PATH = '/open-api/openapi-business-backend/product/query';
export const PRODUCT_FULL_DETAIL_PATH = '/open-api/openapi-business-backend/product/full-detail';
export const MAX_SKUS_PER_FULL_DETAIL = 100;

function record(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} must be an object`);
  }
  return value;
}

function optionalText(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} must be text`);
  }
  return String(value).trim() || null;
}

function nonEmptyText(value, location) {
  const result = optionalText(value, location);
  if (!result) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} is required`);
  }
  return result;
}

function successfulBody(response, path) {
  const body = record(response?.data, 'response');
  if (String(body.code) !== '0') {
    throw new SheinOpenApiError(
      'PLATFORM_ERROR',
      `${path} returned platform error ${String(body.code)}`,
      {
        platformCode: body.code === undefined ? null : String(body.code),
        platformMessage: optionalText(body.msg, 'response.msg')?.slice(0, 240) ?? null,
        traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
      },
    );
  }
  return body;
}

function mapProductListRow(value, location) {
  const row = record(value, location);
  const skuCodes = row.skuCodeList;
  if (!Array.isArray(skuCodes)) {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      `${location}.skuCodeList must be an array`,
    );
  }
  const normalizedSkuCodes = [];
  const seen = new Set();
  for (let index = 0; index < skuCodes.length; index += 1) {
    const skuCode = nonEmptyText(skuCodes[index], `${location}.skuCodeList[${index}]`);
    if (seen.has(skuCode)) {
      throw new SheinOpenApiError(
        'DUPLICATE_PRODUCT_SKU',
        `${location}.skuCodeList contains duplicate SKU ${skuCode}`,
      );
    }
    seen.add(skuCode);
    normalizedSkuCodes.push(skuCode);
  }
  return Object.freeze({
    spuName: nonEmptyText(row.spuName, `${location}.spuName`),
    skcName: nonEmptyText(row.skcName, `${location}.skcName`),
    skuCodes: normalizedSkuCodes,
  });
}

function responseList(body, path) {
  const info = record(body.info, `${path}.info`);
  if (!Array.isArray(info.data)) {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      `${path}.info.data must be an array`,
    );
  }
  return info.data;
}

function normalizeDateFilter(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must use YYYY-MM-DD HH:mm:ss`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`${name} must use YYYY-MM-DD HH:mm:ss`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const roundTrip = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() + 1 !== month
    || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour
    || roundTrip.getUTCMinutes() !== minute
    || roundTrip.getUTCSeconds() !== second
  ) {
    throw new TypeError(`${name} is not a valid Asia/Shanghai calendar date-time`);
  }
  return value;
}

function canonicalCatalog(products) {
  return [...products]
    .map((product) => ({
      spuName: product.spuName,
      skcName: product.skcName,
      skuCodes: [...product.skuCodes].sort(),
    }))
    .sort((left, right) => (
      left.skcName.localeCompare(right.skcName)
      || left.spuName.localeCompare(right.spuName)
    ));
}

function validateCatalogRows(rows) {
  const products = rows.map((row, index) => mapProductListRow(row, `items[${index}]`));
  const seenSkc = new Map();
  const seenSku = new Map();
  for (const product of products) {
    const skcPage = seenSkc.get(product.skcName);
    if (skcPage !== undefined) {
      throw new SheinOpenApiError(
        'CATALOG_PAGE_DRIFT',
        `product/query returned SKC ${product.skcName} more than once in one sweep`,
        { skcName: product.skcName, firstRow: skcPage },
      );
    }
    seenSkc.set(product.skcName, seenSkc.size);
    for (const skuCode of product.skuCodes) {
      const previousSkc = seenSku.get(skuCode);
      if (previousSkc !== undefined) {
        throw new SheinOpenApiError(
          'CATALOG_PAGE_DRIFT',
          `product/query returned SKU ${skuCode} under multiple rows in one sweep`,
          { skuCode, firstSkc: previousSkc, repeatedSkc: product.skcName },
        );
      }
      seenSku.set(skuCode, product.skcName);
    }
  }
  const canonical = canonicalCatalog(products);
  return {
    products,
    productCount: products.length,
    skuCount: seenSku.size,
    fingerprint: payloadFingerprint(canonical),
  };
}

/**
 * Product/query is paged to an explicit short/empty sentinel. A page that is
 * exactly full always causes one extra call, even when the platform count is
 * an exact multiple.
 */
export async function fetchFullManagedProductCatalog(client, {
  pageSize = 50,
  insertTimeStart,
  insertTimeEnd,
  updateTimeStart,
  updateTimeEnd,
  maxPages = 10_000,
  maxItems = 1_000_000,
  maxSweeps = 3,
} = {}) {
  requirePositiveInteger(pageSize, 'pageSize', 500);
  if (!Number.isSafeInteger(maxSweeps) || maxSweeps < 2 || maxSweeps > 3) {
    throw new TypeError('maxSweeps must be an integer from 2 to 3');
  }
  const filters = Object.fromEntries(
    Object.entries({
      insertTimeStart: normalizeDateFilter(insertTimeStart, 'insertTimeStart'),
      insertTimeEnd: normalizeDateFilter(insertTimeEnd, 'insertTimeEnd'),
      updateTimeStart: normalizeDateFilter(updateTimeStart, 'updateTimeStart'),
      updateTimeEnd: normalizeDateFilter(updateTimeEnd, 'updateTimeEnd'),
    }).filter(([, value]) => value !== null),
  );

  let previous = null;
  const sweeps = [];
  for (let sweep = 1; sweep <= maxSweeps; sweep += 1) {
    const result = await fetchPageSequence({
      pageSize,
      maxPages,
      maxItems,
      async fetchPage({ page }) {
        const response = await client.request(PRODUCT_QUERY_PATH, {
          method: 'POST',
          body: { pageNum: page, pageSize, ...filters },
        });
        const body = successfulBody(response, PRODUCT_QUERY_PATH);
        return {
          body,
          rows: responseList(body, 'response'),
          traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
        };
      },
      getItems: ({ rows }) => rows,
      fingerprintItem: (row) => ({
        spuName: row?.spuName ?? null,
        skcName: row?.skcName ?? null,
        skuCodeList: row?.skuCodeList ?? null,
      }),
    });
    const catalog = validateCatalogRows(result.items);
    const sweepEvidence = Object.freeze({
      sweep,
      productCount: catalog.productCount,
      skuCount: catalog.skuCount,
      catalogFingerprint: catalog.fingerprint,
      pages: result.pages,
      terminalReason: result.terminalReason,
    });
    sweeps.push(sweepEvidence);
    if (
      previous
      && previous.productCount === catalog.productCount
      && previous.skuCount === catalog.skuCount
      && previous.fingerprint === catalog.fingerprint
    ) {
      return Object.freeze({
        stable: true,
        products: catalog.products,
        pages: result.pages,
        sweeps,
        sweepCount: sweep,
        terminalReason: result.terminalReason,
        catalogFingerprint: catalog.fingerprint,
        productCount: catalog.productCount,
        skuCount: catalog.skuCount,
        filters,
      });
    }
    previous = catalog;
  }

  throw new SheinOpenApiError(
    'CATALOG_SWEEP_UNSTABLE',
    'product/query did not produce two consecutive identical complete sweeps',
    {
      maxSweeps,
      sweeps: sweeps.map(({ productCount, skuCount, catalogFingerprint }) => ({
        productCount,
        skuCount,
        catalogFingerprint,
      })),
    },
  );
}

function normalizeProductName(value, location) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  const entry = record(value, location);
  return optionalText(entry.productName, `${location}.productName`);
}

function mapFullDetailRow(value, location) {
  const row = record(value, location);
  const skuCode = nonEmptyText(row.skuCode, `${location}.skuCode`);
  const imageRows = row.imageList === null || row.imageList === undefined ? [] : row.imageList;
  if (!Array.isArray(imageRows)) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location}.imageList must be an array`);
  }
  const mainImage = imageRows.find((image) => image?.imageType === 'MAIN') ?? imageRows[0] ?? null;
  const dimensions = row.skuDimensionsInfo === null || row.skuDimensionsInfo === undefined
    ? {}
    : record(row.skuDimensionsInfo, `${location}.skuDimensionsInfo`);
  return Object.freeze({
    skuCode,
    spuName: optionalText(row.spuName, `${location}.spuName`),
    skcName: optionalText(row.skcName, `${location}.skcName`),
    supplierSku: optionalText(row.sellerSku, `${location}.sellerSku`),
    supplierCode: optionalText(row.productNumber, `${location}.productNumber`),
    productName: normalizeProductName(row.productName, `${location}.productName`),
    categoryId: optionalText(row.categoryId, `${location}.categoryId`),
    categoryName: optionalText(row.categoryName, `${location}.categoryName`),
    productTypeId: optionalText(row.productTypeId, `${location}.productTypeId`),
    brandCode: optionalText(row.brandCode, `${location}.brandCode`),
    mainImageUrl: optionalText(mainImage?.imageUrl, `${location}.imageList.imageUrl`),
    dimensions: Object.freeze({
      length: optionalText(dimensions.length, `${location}.skuDimensionsInfo.length`),
      width: optionalText(dimensions.width, `${location}.skuDimensionsInfo.width`),
      height: optionalText(dimensions.height, `${location}.skuDimensionsInfo.height`),
      weight: optionalText(dimensions.weight, `${location}.skuDimensionsInfo.weight`),
    }),
    stopPurchaseCode: optionalText(row.stopPurchase, `${location}.stopPurchase`),
  });
}

function uniqueSkuCodes(skuCodes) {
  if (!Array.isArray(skuCodes)) throw new TypeError('skuCodes must be an array');
  const result = [];
  const seen = new Set();
  for (let index = 0; index < skuCodes.length; index += 1) {
    const skuCode = nonEmptyText(skuCodes[index], `skuCodes[${index}]`);
    if (!seen.has(skuCode)) {
      seen.add(skuCode);
      result.push(skuCode);
    }
  }
  return result;
}

export async function fetchFullManagedProductDetails(client, {
  skuCodes,
  language = 'zh-cn',
} = {}) {
  const requested = uniqueSkuCodes(skuCodes);
  if (requested.length === 0) {
    return Object.freeze({ details: [], batches: [] });
  }
  if (!['en', 'fr', 'es', 'de', 'zh-cn', 'th', 'pt-br'].includes(language)) {
    throw new TypeError('language is not supported by product/full-detail');
  }

  const details = [];
  const batches = [];
  for (let offset = 0; offset < requested.length; offset += MAX_SKUS_PER_FULL_DETAIL) {
    const batchSkuCodes = requested.slice(offset, offset + MAX_SKUS_PER_FULL_DETAIL);
    const response = await client.request(PRODUCT_FULL_DETAIL_PATH, {
      method: 'POST',
      body: { skuCodes: batchSkuCodes, language },
    });
    const body = successfulBody(response, PRODUCT_FULL_DETAIL_PATH);
    if (!Array.isArray(body.info)) {
      throw new SheinOpenApiError(
        'INVALID_RESPONSE_SHAPE',
        'product/full-detail response.info must be an array',
      );
    }
    const mapped = body.info.map((row, index) => mapFullDetailRow(row, `response.info[${index}]`));
    const requestedSet = new Set(batchSkuCodes);
    const returnedSet = new Set();
    for (const detail of mapped) {
      if (!requestedSet.has(detail.skuCode)) {
        throw new SheinOpenApiError(
          'UNEXPECTED_RESPONSE_SKU',
          `product/full-detail returned unrequested SKU ${detail.skuCode}`,
        );
      }
      if (returnedSet.has(detail.skuCode)) {
        throw new SheinOpenApiError(
          'DUPLICATE_RESPONSE_SKU',
          `product/full-detail returned duplicate SKU ${detail.skuCode}`,
        );
      }
      returnedSet.add(detail.skuCode);
    }
    const missingSkuCodes = batchSkuCodes.filter((skuCode) => !returnedSet.has(skuCode));
    if (missingSkuCodes.length > 0) {
      throw new SheinOpenApiError(
        'MISSING_REQUESTED_SKU',
        `product/full-detail omitted ${missingSkuCodes.length} requested SKU(s)`,
        { missingSkuCodes },
      );
    }
    details.push(...mapped);
    batches.push(Object.freeze({
      batchIndex: batches.length,
      skuCount: batchSkuCodes.length,
      responseCount: mapped.length,
      requestFingerprint: payloadFingerprint({ skuCodes: batchSkuCodes, language }),
      responseFingerprint: payloadFingerprint(mapped),
      traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
    }));
  }
  return Object.freeze({ details, batches });
}
