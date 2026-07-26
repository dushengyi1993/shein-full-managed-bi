import { SheinOpenApiError } from './shein-client.mjs';
import {
  fetchPageSequence,
  payloadFingerprint,
  requirePositiveInteger,
} from './paginated-fetch.mjs';

export const STOCK_GOODS_LIST_PATH = '/open-api/openapi-business-backend/stock-goods-list';
export const MAX_STOCK_GOODS_PAGE_SIZE = 20;

function record(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} must be an object`);
  }
  return value;
}

function optionalText(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', `${location} must be scalar`);
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

function optionalQuantity(value, location) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      `${location} must be a non-negative integer`,
    );
  }
  return normalized;
}

function optionalNumber(value, location) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      `${location} must be a non-negative number`,
    );
  }
  return normalized;
}

function status(value, location) {
  if (value === undefined || value === null) {
    return Object.freeze({
      observed: false,
      isWarning: null,
      code: null,
      label: null,
      type: null,
      note: null,
    });
  }
  const row = record(value, location);
  const type = optionalText(row.type, `${location}.type`);
  const normalizedType = type?.toLowerCase() ?? null;
  const isWarning = ['warning', 'warn', 'danger', 'error'].includes(normalizedType)
    ? true
    : ['success', 'normal', 'ok', 'none', 'no-warning'].includes(normalizedType)
      ? false
      : null;
  return Object.freeze({
    observed: isWarning !== null,
    isWarning,
    code: optionalText(
      row.value ?? row.goodsLevel ?? row.type,
      `${location}.value`,
    ),
    label: optionalText(
      row.name ?? row.goodsLevelName,
      `${location}.name`,
    ),
    type,
    note: optionalText(row.note, `${location}.note`),
  });
}

function mapSku(value, product, location) {
  const row = record(value, location);
  const skuCode = nonEmptyText(row.skuCode, `${location}.skuCode`);
  if (skuCode === '合计' || skuCode.toLowerCase() === 'total') return null;
  return Object.freeze({
    skuCode,
    skcName: product.skcName,
    spuName: product.spuName,
    supplierCode: product.supplierCode,
    variantName: optionalText(row.suffixZh ?? row.attr, `${location}.suffixZh`),
    predictedDailySales: optionalQuantity(row.predictDaySales, `${location}.predictDaySales`),
    pendingOrderQuantity: optionalQuantity(row.orderCnt, `${location}.orderCnt`),
    totalSalesQuantity: optionalQuantity(row.totalSaleVolume, `${location}.totalSaleVolume`),
    sales7Days: optionalQuantity(row.c7dSaleCnt, `${location}.c7dSaleCnt`),
    sales30Days: optionalQuantity(row.c30dSaleCnt, `${location}.c30dSaleCnt`),
    pendingDeliveryQuantity: optionalQuantity(row.stayDeliver, `${location}.stayDeliver`),
    pendingShelfQuantity: optionalQuantity(row.stayShelf, `${location}.stayShelf`),
    transitQuantity: optionalQuantity(row.transit, `${location}.transit`),
    stockQuantity: optionalQuantity(row.stock, `${location}.stock`),
    transitSaleQuantity: optionalQuantity(row.transitSale, `${location}.transitSale`),
    preemptionQuantity: optionalQuantity(row.preemptionNum, `${location}.preemptionNum`),
    plannedUrgentQuantity: optionalQuantity(
      row.planUrgentCount,
      `${location}.planUrgentCount`,
    ),
    advisedOrderQuantity: optionalQuantity(
      row.adviceOrderCount,
      `${location}.adviceOrderCount`,
    ),
    placedOrderQuantity: optionalQuantity(row.orderCount, `${location}.orderCount`),
    stockSaleDays: optionalNumber(row.stockSaleDays, `${location}.stockSaleDays`),
    saleDays: optionalNumber(row.saleDays, `${location}.saleDays`),
    stockDays: optionalNumber(row.stockDays, `${location}.stockDays`),
    price: optionalNumber(row.price === '-' ? null : row.price, `${location}.price`),
    currencySymbol: optionalText(row.currencySymbol, `${location}.currencySymbol`),
    autoOrderStatusCode: optionalText(row.autoOrderStatus, `${location}.autoOrderStatus`),
    mallSaleStatusCode: optionalText(row.mallSaleStatus, `${location}.mallSaleStatus`),
  });
}

function mapGoods(value, location) {
  const row = record(value, location);
  if (!Array.isArray(row.skuList)) {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      `${location}.skuList must be an array`,
    );
  }
  const product = {
    skcName: nonEmptyText(row.skc, `${location}.skc`),
    spuName: nonEmptyText(row.spuName ?? row.spu, `${location}.spuName`),
    supplierCode: optionalText(row.supplierCode, `${location}.supplierCode`),
  };
  return Object.freeze({
    ...product,
    categoryName: optionalText(row.categoryName, `${location}.categoryName`),
    shelfDays: optionalQuantity(row.shelfDays, `${location}.shelfDays`),
    supplyStatus: status(row.supplyStatus, `${location}.supplyStatus`),
    shelfStatus: status(row.shelfStatus, `${location}.shelfStatus`),
    saleModel: status(row.saleModel, `${location}.saleModel`),
    qualityGrade: status(row.qualityGrade, `${location}.qualityGrade`),
    goodsLevel: status(row.goodsLevel, `${location}.goodsLevel`),
    stockStandard: status(row.stockStandard, `${location}.stockStandard`),
    stockWarningStatus: status(row.stockWarnStatus, `${location}.stockWarnStatus`),
    skus: row.skuList
      .map((sku, index) => mapSku(sku, product, `${location}.skuList[${index}]`))
      .filter(Boolean),
  });
}

function normalizeFetchedAt(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (
    (typeof value !== 'string' && !(value instanceof Date))
    || Number.isNaN(date.valueOf())
  ) {
    throw new TypeError('fetchedAt must be a valid date-time');
  }
  return date.toISOString();
}

export async function fetchFullManagedStockAdvice(client, {
  pageSize = 20,
  maxPages = 10_000,
  maxItems = 1_000_000,
  fetchedAt = new Date(),
} = {}) {
  requirePositiveInteger(pageSize, 'pageSize', MAX_STOCK_GOODS_PAGE_SIZE);
  const result = await fetchPageSequence({
    pageSize,
    maxPages,
    maxItems,
    async fetchPage({ page }) {
      const response = await client.request(STOCK_GOODS_LIST_PATH, {
        method: 'POST',
        body: { pageNum: page, pageSize },
      });
      const body = record(response?.data, 'response');
      if (String(body.code) !== '0') {
        throw new SheinOpenApiError(
          'PLATFORM_ERROR',
          `${STOCK_GOODS_LIST_PATH} returned platform error ${String(body.code)}`,
          {
            platformCode: body.code === undefined ? null : String(body.code),
            platformMessage: optionalText(body.msg, 'response.msg')?.slice(0, 240) ?? null,
          },
        );
      }
      const info = record(body.info, 'response.info');
      if (!Array.isArray(info.list)) {
        throw new SheinOpenApiError(
          'INVALID_RESPONSE_SHAPE',
          'response.info.list must be an array',
        );
      }
      const count = Number(info.count ?? 0);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new SheinOpenApiError(
          'INVALID_RESPONSE_SHAPE',
          'response.info.count must be a non-negative integer',
        );
      }
      return { rows: info.list, count };
    },
    getItems: ({ rows }) => rows,
    getAdvertisedCount: ({ count }) => count,
    fingerprintItem: (row) => ({
      id: row?.id ?? null,
      skc: row?.skc ?? null,
      supplierCode: row?.supplierCode ?? null,
      skuList: row?.skuList ?? null,
    }),
  });
  const goods = result.items.map((row, index) => mapGoods(row, `items[${index}]`));
  const observationTime = normalizeFetchedAt(fetchedAt);
  const advice = goods.flatMap(({ skus, ...product }) => (
    skus.map((sku) => Object.freeze({
      ...sku,
      productStatuses: Object.freeze({
        supplyStatus: product.supplyStatus,
        shelfStatus: product.shelfStatus,
        saleModel: product.saleModel,
        qualityGrade: product.qualityGrade,
        goodsLevel: product.goodsLevel,
        stockStandard: product.stockStandard,
        stockWarningStatus: product.stockWarningStatus,
      }),
      fetchedAt: observationTime,
    }))
  ));
  return Object.freeze({
    goods,
    advice,
    coverage: Object.freeze({
      status: 'COMPLETE',
      requestedCount: null,
      observedCount: advice.length,
      explanation: 'All pages reached a short or empty terminal page; an empty list clears the current advice projection.',
    }),
    pages: result.pages,
    terminalReason: result.terminalReason,
    requestFingerprint: payloadFingerprint({ pageSize }),
  });
}
