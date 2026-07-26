export class InventoryDomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InventoryDomainError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new InventoryDomainError(code, message, details);
}

function record(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_FIELD', `${location} must be an object`, { location });
  }
  return value;
}

function optionalText(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail('INVALID_FIELD', `${location} must be text`, { location, value });
  }
  return String(value).trim() || null;
}

function requiredText(value, location) {
  const normalized = optionalText(value, location);
  if (!normalized) fail('MISSING_FIELD', `${location} is required`, { location });
  return normalized;
}

function quantity(value, location, { optional = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (optional) return null;
    fail('MISSING_FIELD', `${location} is required`, { location });
  }
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    fail('INVALID_QUANTITY', `${location} must be a non-negative safe integer`, {
      location,
      value,
    });
  }
  return normalized;
}

function normalizeFetchedAt(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (
    (typeof value !== 'string' && !(value instanceof Date))
    || Number.isNaN(date.valueOf())
  ) {
    fail('INVALID_FETCHED_AT', 'fetchedAt must be a valid date-time');
  }
  return date.toISOString();
}

const METRICS = Object.freeze([
  ['inventoryQuantity', 'totalInventoryQuantity'],
  ['lockedQuantity', 'totalLockedQuantity'],
  ['tempLockQuantity', 'totalTempLockQuantity'],
  ['usableInventory', 'totalUsableInventory'],
  ['outOfStockQty', 'totalOutOfStockQty'],
  ['transitQuantity', 'totalTransitQuantity'],
]);

function mapWarehouse(value, location) {
  const row = record(value, location);
  return Object.freeze({
    warehouseCode: requiredText(row.warehouseCode, `${location}.warehouseCode`),
    warehouseTypeCode: requiredText(row.warehouseType, `${location}.warehouseType`),
    inventoryQuantity: quantity(row.inventoryQuantity, `${location}.inventoryQuantity`),
    lockedQuantity: quantity(row.lockedQuantity, `${location}.lockedQuantity`),
    tempLockQuantity: quantity(row.tempLockQuantity, `${location}.tempLockQuantity`),
    usableInventory: quantity(row.usableInventory, `${location}.usableInventory`),
    outOfStockQty: quantity(row.outOfStockQty, `${location}.outOfStockQty`, { optional: true }),
    transitQuantity: quantity(row.transitQuantity, `${location}.transitQuantity`, { optional: true }),
  });
}

function reconcileTotals(item) {
  if (item.warehouses.length === 0) {
    return Object.freeze({
      status: 'TOTAL_ONLY',
      explanation: 'SHEIN returned aggregate inventory totals without warehouse detail; no warehouse sum can be claimed.',
      checks: [],
    });
  }

  const checks = METRICS.map(([detailField, totalField]) => {
    const expected = item[totalField];
    const detailValues = item.warehouses.map((warehouse) => warehouse[detailField]);
    if (expected === null) {
      return Object.freeze({
        metric: totalField,
        status: 'NOT_EXPOSED',
        aggregate: null,
        warehouseSum: null,
      });
    }
    if (detailValues.some((value) => value === null)) {
      return Object.freeze({
        metric: totalField,
        status: 'PARTIAL_DETAIL',
        aggregate: expected,
        warehouseSum: null,
      });
    }
    const warehouseSum = detailValues.reduce((sum, value) => sum + value, 0);
    return Object.freeze({
      metric: totalField,
      status: warehouseSum === expected ? 'MATCH' : 'MISMATCH',
      aggregate: expected,
      warehouseSum,
    });
  });

  const status = checks.some(({ status: checkStatus }) => checkStatus === 'MISMATCH')
    ? 'MISMATCH'
    : checks.some(({ status: checkStatus }) => checkStatus === 'PARTIAL_DETAIL')
      ? 'PARTIAL_DETAIL'
      : 'RECONCILED';
  const explanation = status === 'MISMATCH'
    ? 'At least one SHEIN aggregate inventory value differs from the sum of warehouse details.'
    : status === 'PARTIAL_DETAIL'
      ? 'SHEIN omitted at least one warehouse-level metric, so only the exposed metrics were reconciled.'
      : 'Every exposed aggregate inventory value matches the sum of warehouse details.';
  return Object.freeze({ status, explanation, checks });
}

function mapSku(value, context, location) {
  const row = record(value, location);
  const warehouseRows = row.warehouseInventoryList ?? [];
  if (!Array.isArray(warehouseRows)) {
    fail('INVALID_FIELD', `${location}.warehouseInventoryList must be an array`);
  }
  const item = {
    spuName: optionalText(context.spuName, `${location}.spuName`),
    skcName: optionalText(context.skcName, `${location}.skcName`),
    skuCode: requiredText(row.skuCode, `${location}.skuCode`),
    totalInventoryQuantity: quantity(
      row.totalInventoryQuantity,
      `${location}.totalInventoryQuantity`,
    ),
    totalLockedQuantity: quantity(row.totalLockedQuantity, `${location}.totalLockedQuantity`),
    totalTempLockQuantity: quantity(
      row.totalTempLockQuantity,
      `${location}.totalTempLockQuantity`,
    ),
    totalUsableInventory: quantity(
      row.totalUsableInventory,
      `${location}.totalUsableInventory`,
    ),
    totalOutOfStockQty: quantity(
      row.totalOutOfStockQty,
      `${location}.totalOutOfStockQty`,
      { optional: true },
    ),
    totalTransitQuantity: quantity(
      row.totalTransitQuantity,
      `${location}.totalTransitQuantity`,
      { optional: true },
    ),
    warehouses: warehouseRows.map((warehouse, index) => (
      mapWarehouse(warehouse, `${location}.warehouseInventoryList[${index}]`)
    )),
  };
  return Object.freeze({
    ...item,
    reconciliation: reconcileTotals(item),
  });
}

function goodsGroups(info) {
  const containers = Array.isArray(info) ? info : [record(info, 'response.info')];
  const groups = [];
  for (let index = 0; index < containers.length; index += 1) {
    const container = record(containers[index], `response.info[${index}]`);
    if (!Array.isArray(container.goodsInventory)) {
      fail(
        'INVALID_FIELD',
        `response.info[${index}].goodsInventory must be an array`,
      );
    }
    groups.push(...container.goodsInventory);
  }
  return groups;
}

export function mapStockQueryResponse({
  response,
  queryDimension,
  requestedCodes,
  inventoryType,
  fetchedAt = new Date(),
} = {}) {
  const body = record(response, 'response');
  if (String(body.code) !== '0') {
    fail('OPENAPI_RESPONSE_ERROR', `stock-query failed with code ${String(body.code)}`, {
      platformCode: body.code === undefined ? null : String(body.code),
      platformMessage: optionalText(body.msg, 'response.msg'),
      traceId: optionalText(body.traceId, 'response.traceId'),
    });
  }
  if (!['SKU', 'SKC', 'SPU'].includes(queryDimension)) {
    fail('INVALID_QUERY_DIMENSION', 'queryDimension must be SKU, SKC or SPU');
  }
  if (!Array.isArray(requestedCodes) || requestedCodes.length === 0) {
    fail('INVALID_REQUEST_CODES', 'requestedCodes must be a non-empty array');
  }

  const items = [];
  const observedCodes = new Set();
  const groups = goodsGroups(body.info);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = record(groups[groupIndex], `response.info.goodsInventory[${groupIndex}]`);
    const spuName = optionalText(group.spuName, `goodsInventory[${groupIndex}].spuName`);
    const skcName = optionalText(group.skcName, `goodsInventory[${groupIndex}].skcName`);
    if (!Array.isArray(group.skuList)) {
      fail('INVALID_FIELD', `goodsInventory[${groupIndex}].skuList must be an array`);
    }
    if (queryDimension === 'SPU' && spuName) observedCodes.add(spuName);
    if (queryDimension === 'SKC' && skcName) observedCodes.add(skcName);
    for (let skuIndex = 0; skuIndex < group.skuList.length; skuIndex += 1) {
      const mapped = mapSku(
        group.skuList[skuIndex],
        { spuName, skcName },
        `goodsInventory[${groupIndex}].skuList[${skuIndex}]`,
      );
      if (queryDimension === 'SKU') observedCodes.add(mapped.skuCode);
      items.push(mapped);
    }
  }

  const requested = [...new Set(requestedCodes.map((value) => requiredText(value, 'requestedCodes')))];
  const requestedSet = new Set(requested);
  const unexpectedCodes = [...observedCodes].filter((code) => !requestedSet.has(code));
  if (unexpectedCodes.length > 0) {
    fail(
      'UNEXPECTED_RESPONSE_IDENTIFIER',
      `stock-query returned ${unexpectedCodes.length} unrequested ${queryDimension} identifier(s)`,
      {
        queryDimension,
        unexpectedCodes,
      },
    );
  }
  const missingCodes = requested.filter((code) => !observedCodes.has(code));
  const duplicateSkuCodes = items
    .map(({ skuCode }) => skuCode)
    .filter((skuCode, index, all) => all.indexOf(skuCode) !== index);
  if (duplicateSkuCodes.length > 0) {
    fail('DUPLICATE_RESPONSE_SKU', 'stock-query returned a SKU more than once', {
      duplicateSkuCodes: [...new Set(duplicateSkuCodes)],
    });
  }

  return Object.freeze({
    queryDimension,
    requestedCodes: requested,
    inventoryType,
    fetchedAt: normalizeFetchedAt(fetchedAt),
    items,
    shortages: items
      .filter(({ totalOutOfStockQty }) => (totalOutOfStockQty ?? 0) > 0)
      .map(({ skuCode, totalOutOfStockQty }) => Object.freeze({
        skuCode,
        shortageQuantity: totalOutOfStockQty,
      })),
    coverage: Object.freeze({
      status: missingCodes.length === 0 ? 'COMPLETE' : 'PARTIAL',
      requestedCount: requested.length,
      observedCount: observedCodes.size,
      missingCodes,
      unexpectedCodes: [],
      explanation: missingCodes.length === 0
        ? 'Every requested identifier was present in the successful SHEIN response.'
        : 'SHEIN omitted requested identifiers; they remain unknown and were not converted to zero inventory.',
    }),
    traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
  });
}
