import { mapStockQueryResponse } from '../domain/inventory.mjs';
import { SheinOpenApiError } from './shein-client.mjs';
import { payloadFingerprint } from './paginated-fetch.mjs';

export const STOCK_QUERY_PATH = '/open-api/stock/stock-query';
export const MAX_IDENTIFIERS_PER_STOCK_QUERY = 100;

const DIMENSIONS = Object.freeze({
  skuCodeList: 'SKU',
  skcNameList: 'SKC',
  spuNameList: 'SPU',
});

function normalizeCodes(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  const seen = new Set();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string' || value[index].trim() === '') {
      throw new TypeError(`${name}[${index}] must be a non-empty string`);
    }
    const code = value[index].trim();
    if (!seen.has(code)) {
      seen.add(code);
      result.push(code);
    }
  }
  return result;
}

function normalizeInventorySelectors({ invType, warehouseType } = {}) {
  const normalizedInvType = invType === undefined || invType === null || invType === ''
    ? null
    : String(invType).trim().toUpperCase();
  if (normalizedInvType !== null && !['PI', 'VI', 'JI'].includes(normalizedInvType)) {
    throw new TypeError('invType must be PI, VI or JI');
  }
  const normalizedWarehouseType = warehouseType === undefined
    || warehouseType === null
    || warehouseType === ''
    ? null
    : String(warehouseType).trim();
  if (
    normalizedWarehouseType !== null
    && !['1', '2', '3'].includes(normalizedWarehouseType)
  ) {
    throw new TypeError('warehouseType must be 1, 2 or 3');
  }
  if (normalizedInvType === null && normalizedWarehouseType === null) {
    throw new TypeError('invType is required (warehouseType is accepted during the official transition)');
  }
  const officialTransitionWarehouseType = normalizedInvType === null
    ? null
    : normalizedInvType === 'PI'
      ? '1'
      : '3';
  if (
    normalizedWarehouseType !== null
    && officialTransitionWarehouseType !== null
    && normalizedWarehouseType !== officialTransitionWarehouseType
  ) {
    throw new TypeError(
      `warehouseType must be ${officialTransitionWarehouseType} when invType is ${normalizedInvType}`,
    );
  }
  return {
    ...(
      normalizedWarehouseType === null && officialTransitionWarehouseType === null
        ? {}
        : { warehouseType: normalizedWarehouseType ?? officialTransitionWarehouseType }
    ),
    ...(normalizedInvType === null ? {} : { invType: normalizedInvType }),
  };
}

/**
 * Fetch one official stock-query batch. The API requires exactly one lookup
 * dimension and permits at most 100 identifiers. During the official
 * warehouseType -> invType transition, invType requests also carry the
 * compatible legacy selector: PI=1 and VI/JI=3.
 */
export async function fetchFullManagedInventory(client, {
  skuCodeList,
  skcNameList,
  spuNameList,
  invType,
  warehouseType,
  fetchedAt = new Date(),
} = {}) {
  const dimensions = Object.entries({ skuCodeList, skcNameList, spuNameList })
    .map(([name, values]) => [name, normalizeCodes(values, name)])
    .filter(([, values]) => values.length > 0);
  if (dimensions.length !== 1) {
    throw new TypeError(
      'exactly one of skuCodeList, skcNameList or spuNameList must be non-empty',
    );
  }
  const [field, codes] = dimensions[0];
  if (codes.length > MAX_IDENTIFIERS_PER_STOCK_QUERY) {
    throw new TypeError(
      `${field} cannot contain more than ${MAX_IDENTIFIERS_PER_STOCK_QUERY} identifiers`,
    );
  }
  const selectors = normalizeInventorySelectors({ invType, warehouseType });
  const requestBody = { [field]: codes, ...selectors };
  const response = await client.request(STOCK_QUERY_PATH, {
    method: 'POST',
    body: requestBody,
  });
  if (!response || response.data === null || typeof response.data !== 'object') {
    throw new SheinOpenApiError(
      'INVALID_RESPONSE_SHAPE',
      'stock-query returned a non-object response',
    );
  }
  const mapped = mapStockQueryResponse({
    response: response.data,
    queryDimension: DIMENSIONS[field],
    requestedCodes: codes,
    inventoryType: selectors.invType ?? `WAREHOUSE_TYPE_${selectors.warehouseType}`,
    fetchedAt,
  });
  return Object.freeze({
    ...mapped,
    requestFingerprint: payloadFingerprint(requestBody),
  });
}
