import {
  createSkuSalesQueryBatches,
  inspectSkuSalesResponseForPermissionProbe,
  mapSkuSalesResponseToSnapshots,
} from '../domain/sku-sales-snapshot.mjs';
import { SheinOpenApiError } from './shein-client.mjs';

export const NUMBER_LIST_PATH = '/open-api/goods/number-list';
export const QUERY_SKU_SALES_PATH = '/open-api/goods/query-sku-sales';

function record(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} must be an object`);
  }
  return value;
}

function integer(value, location, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} must be an integer >= ${minimum}`);
  }
  return value;
}

function optionalText(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} must be a string`);
  }
  return value.trim() || null;
}

function mapNumberRow(value, location) {
  const item = record(value, location);
  const skuCode = optionalText(item.sku_code, `${location}.sku_code`);
  if (!skuCode) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location}.sku_code is required`);
  }
  const skc = optionalText(item.skc, `${location}.skc`);
  if (!skc) {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      `${location}.skc is required when number-list type=1`,
    );
  }
  return {
    skuCode,
    skc,
    designCode: optionalText(item.design_code, `${location}.design_code`),
    supplierSku: optionalText(item.supplier_sku, `${location}.supplier_sku`),
    attribute: optionalText(item.attribute, `${location}.attribute`),
  };
}

export async function fetchFullManagedSkuInventoryPage(client, { page = 1, pageSize = 100 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1) throw new TypeError('page must be a positive integer');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('pageSize must be an integer from 1 to 100');
  }
  const response = await client.request(NUMBER_LIST_PATH, {
    method: 'GET',
    query: { page, per_page: pageSize, type: 1 },
  });
  const body = record(response.data, 'response');
  if (String(body.code) !== '0') {
    throw new SheinOpenApiError('PLATFORM_ERROR', `${NUMBER_LIST_PATH} returned platform error ${String(body.code)}`, {
      platformCode: body.code === undefined ? null : String(body.code),
      platformMessage: typeof body.msg === 'string' ? body.msg.slice(0, 240) : null,
      traceId: typeof body.traceId === 'string' ? body.traceId.slice(0, 128) : null,
    });
  }
  const info = record(body.info, 'response.info');
  const responsePage = integer(info.page, 'response.info.page', 1);
  const responsePageSize = integer(info.per_page, 'response.info.per_page', 1);
  const count = integer(info.count, 'response.info.count');
  if (!Array.isArray(info.list)) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', 'response.info.list must be an array');
  }
  if (responsePage !== page || responsePageSize > 100) {
    throw new SheinOpenApiError('PAGINATION_MISMATCH', 'number-list pagination metadata is inconsistent', {
      requestedPage: page,
      responsePage,
      responsePageSize,
    });
  }
  const items = info.list.map((item, index) => mapNumberRow(item, `response.info.list[${index}]`));
  return {
    page,
    perPage: responsePageSize,
    count,
    items,
    traceId: typeof body.traceId === 'string' ? body.traceId.slice(0, 128) : null,
    message: typeof body.msg === 'string' ? body.msg.slice(0, 240) : null,
  };
}

function canonicalInventory(items) {
  return JSON.stringify(
    [...items].sort((left, right) => left.skuCode.localeCompare(right.skuCode)),
  );
}

async function scanFullManagedSkuInventory(client, { pageSize, maxPages, maxItems }) {
  const items = [];
  const pages = [];
  const seenSkus = new Map();
  const skcPages = new Map();
  let advertisedCount = null;
  let responsePageSize = null;
  let consecutiveEmptyPages = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const pageResult = await fetchFullManagedSkuInventoryPage(client, { page, pageSize });
    if (advertisedCount !== null && advertisedCount !== pageResult.count) {
      throw new SheinOpenApiError('PAGINATION_DRIFT', 'number-list count changed during pagination', {
        advertisedCount,
        observedCount: pageResult.count,
        page,
      });
    }
    if (responsePageSize !== null && responsePageSize !== pageResult.perPage) {
      throw new SheinOpenApiError(
        'PAGINATION_DRIFT',
        'number-list per_page changed during pagination',
        {
          responsePageSize,
          observedPageSize: pageResult.perPage,
          page,
        },
      );
    }
    advertisedCount = pageResult.count;
    responsePageSize = pageResult.perPage;

    const skcsOnPage = new Set();
    for (const item of pageResult.items) {
      const previous = seenSkus.get(item.skuCode);
      if (previous) {
        const code = JSON.stringify(previous) === JSON.stringify(item)
          ? 'PAGINATION_SKU_OVERLAP'
          : 'DUPLICATE_SKU_DRIFT';
        throw new SheinOpenApiError(
          code,
          `number-list returned SKU ${item.skuCode} more than once in one scan`,
          { page },
        );
      }
      const previousSkcPage = skcPages.get(item.skc);
      if (previousSkcPage !== undefined && previousSkcPage !== page) {
        throw new SheinOpenApiError(
          'PAGINATION_SKC_OVERLAP',
          'number-list split or repeated one SKC across pages',
          { firstPage: previousSkcPage, repeatedPage: page },
        );
      }
      seenSkus.set(item.skuCode, item);
      skcPages.set(item.skc, page);
      skcsOnPage.add(item.skc);
      items.push(item);
      if (items.length > maxItems) {
        throw new SheinOpenApiError(
          'PAGINATION_ITEM_LIMIT',
          'number-list exceeded the configured SKU safety limit',
          { maxItems },
        );
      }
    }
    pages.push({
      page,
      perPage: pageResult.perPage,
      count: pageResult.count,
      recordCount: pageResult.items.length,
      skcCount: skcsOnPage.size,
      traceId: pageResult.traceId,
      message: pageResult.message,
    });

    // For type=1 SHEIN paginates SKC groups, while each list entry is an
    // expanded SKU row. Two explicit empty pages form a fail-closed sentinel
    // against a transient empty page while a live catalog is being scanned.
    if (pageResult.items.length === 0) {
      consecutiveEmptyPages += 1;
      if (consecutiveEmptyPages < 2) continue;
      if (skcPages.size !== advertisedCount) {
        throw new SheinOpenApiError(
          'PAGINATION_COUNT_MISMATCH',
          'number-list unique SKC count did not match the advertised type=1 count',
          {
            advertisedCount,
            uniqueSkcCount: skcPages.size,
            uniqueSkuCount: seenSkus.size,
          },
        );
      }
      return {
        items: [...items].sort((left, right) => left.skuCode.localeCompare(right.skuCode)),
        pages,
        count: items.length,
        advertisedCount,
      };
    }
    if (consecutiveEmptyPages > 0) {
      throw new SheinOpenApiError(
        'PAGINATION_EMPTY_GAP',
        'number-list returned data after an empty page in the same scan',
        { page },
      );
    }
    if (page === maxPages) {
      throw new SheinOpenApiError('PAGINATION_LIMIT', 'number-list did not reach an empty sentinel page', {
        maxPages,
      });
    }
  }

  throw new SheinOpenApiError('PAGINATION_LIMIT', 'number-list exceeded the configured page safety limit', {
    maxPages,
  });
}

export async function fetchFullManagedSkuInventory(client, {
  pageSize = 100,
  maxPages = 100_000,
  maxItems = 1_000_000,
  maxSweeps = 3,
} = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('pageSize must be an integer from 1 to 100');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError('maxPages must be positive');
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) throw new TypeError('maxItems must be positive');
  if (!Number.isSafeInteger(maxSweeps) || maxSweeps < 2 || maxSweeps > 3) {
    throw new TypeError('maxSweeps must be an integer from 2 to 3');
  }

  let previous = null;
  let previousFingerprint = null;
  for (let sweep = 1; sweep <= maxSweeps; sweep += 1) {
    const current = await scanFullManagedSkuInventory(client, { pageSize, maxPages, maxItems });
    const fingerprint = canonicalInventory(current.items);
    if (
      previous
      && current.advertisedCount === previous.advertisedCount
      && fingerprint === previousFingerprint
    ) {
      return { ...current, sweepCount: sweep };
    }
    previous = current;
    previousFingerprint = fingerprint;
  }

  throw new SheinOpenApiError(
    'PAGINATION_UNSTABLE',
    'number-list did not produce two consecutive identical full inventory scans',
    {
      maxSweeps,
      lastAdvertisedCount: previous?.advertisedCount ?? null,
      lastUniqueSkuCount: previous?.items.length ?? null,
    },
  );
}

export async function fetchFullManagedSkuSales(client, { storeCode, skuCodes, fetchedAt = new Date() } = {}) {
  const batches = createSkuSalesQueryBatches(skuCodes);
  const snapshots = [];
  const evidence = [];

  for (let index = 0; index < batches.length; index += 1) {
    const body = batches[index];
    const response = await client.request(QUERY_SKU_SALES_PATH, { method: 'POST', body });
    const mapped = mapSkuSalesResponseToSnapshots({
      storeCode,
      requestedSkuCodes: body.skuCodeList,
      fetchedAt,
      response: response.data,
    });
    snapshots.push(...mapped);
    evidence.push({
      batchIndex: index,
      skuCount: body.skuCodeList.length,
      responseRecordCount: mapped.length,
      traceId: typeof response.data.traceId === 'string' ? response.data.traceId.slice(0, 128) : null,
      message: typeof response.data.msg === 'string' ? response.data.msg.slice(0, 240) : null,
    });
  }
  return { snapshots, batches: evidence };
}

const DENIED_PATTERN = /\b(denied|rejected|forbidden)\b|拒绝|驳回|禁止/i;
const PENDING_PATTERN = /permission|authorize|authorise|scope|package|pending|审核|权限|授权|申请/i;

export function classifySalesProbeError(error) {
  const details = error?.details ?? {};
  const combined = `${details.platformCode ?? ''} ${details.platformMessage ?? ''} ${error?.message ?? ''}`;
  if (DENIED_PATTERN.test(combined)) return 'DENIED';
  if (error?.code === 'PLATFORM_ERROR' && PENDING_PATTERN.test(combined)) return 'PENDING';
  return 'ERROR';
}

/** A successful zero-sales response is GRANTED; missing inventory cannot prove sales permission. */
export async function probeFullManagedSalesPermission(client, { storeCode } = {}) {
  const probedAt = new Date().toISOString();
  try {
    const inventoryPage = await fetchFullManagedSkuInventoryPage(client, { page: 1, pageSize: 1 });
    if (inventoryPage.items.length === 0) {
      return {
        outcome: 'PENDING',
        probedAt,
        httpStatus: 200,
        platformErrorCode: null,
        platformMessage: 'No SKU is available to exercise query-sku-sales.',
        evidence: { storeCode, endpointReached: NUMBER_LIST_PATH, salesEndpointExercised: false },
      };
    }
    const skuCode = inventoryPage.items[0].skuCode;
    const response = await client.request(QUERY_SKU_SALES_PATH, {
      method: 'POST',
      body: { skuCodeList: [skuCode] },
    });
    const validation = inspectSkuSalesResponseForPermissionProbe({
      requestedSkuCodes: [skuCode],
      response: response.data,
    });
    return {
      outcome: 'GRANTED',
      probedAt,
      httpStatus: 200,
      platformErrorCode: null,
      platformMessage: validation.statisticsDateAvailable
        ? 'query-sku-sales returned code 0.'
        : 'query-sku-sales returned code 0, but dt was empty; permission is granted and fact loading remains blocked.',
      evidence: {
        storeCode,
        endpointReached: QUERY_SKU_SALES_PATH,
        salesEndpointExercised: true,
        statisticsDateAvailable: validation.statisticsDateAvailable,
        dataLoadable: validation.statisticsDateAvailable,
        dataQualityStatus: validation.statisticsDateAvailable ? 'VALID' : 'DEGRADED',
        dataQualityReason: validation.statisticsDateAvailable ? null : 'MISSING_STATISTICS_DATE',
      },
    };
  } catch (error) {
    return {
      outcome: classifySalesProbeError(error),
      probedAt,
      httpStatus: error?.details?.httpStatus ?? null,
      platformErrorCode: error?.details?.platformCode ?? error?.code ?? null,
      platformMessage: String(error?.details?.platformMessage ?? error?.message ?? 'Unknown probe error').slice(0, 240),
      evidence: { storeCode, endpointReached: error?.details?.path ?? null, salesEndpointExercised: false },
    };
  }
}
