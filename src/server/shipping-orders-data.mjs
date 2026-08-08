import { readFile, stat } from 'node:fs/promises';

const CACHE = new Map();

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function rows(value) {
  return Array.isArray(value) ? value : [];
}

export class ShippingOrdersDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShippingOrdersDataError';
    this.code = code;
  }
}

function normalizeShippingOrders(value) {
  const source = record(value);
  if (source.schemaVersion !== 1) {
    throw new ShippingOrdersDataError('SHIPPING_ORDERS_SCHEMA_UNSUPPORTED', '发货订单数据版本不受支持');
  }
  const orders = rows(source.orders).filter((order) => (
    order && typeof order === 'object' && !Array.isArray(order)
    && typeof order.storeCode === 'string'
    && typeof order.orderNo === 'string'
  ));
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: source.updatedAt ?? null,
    source: Object.freeze(record(source.source)),
    capabilities: Object.freeze(record(source.capabilities)),
    orders: Object.freeze(orders),
  });
}

export async function loadShippingOrdersData(
  file = process.env.FULL_BI_SHIPPING_ORDERS_FILE,
  { runtimeEnvironment = process.env.NODE_ENV || 'development', forceRefresh = false } = {},
) {
  if (!file && String(runtimeEnvironment).toLowerCase() === 'production') {
    throw new ShippingOrdersDataError(
      'SHIPPING_ORDERS_FILE_REQUIRED',
      'FULL_BI_SHIPPING_ORDERS_FILE is required in production',
    );
  }
  if (!file) {
    return Object.freeze({
      schemaVersion: 1,
      updatedAt: null,
      source: Object.freeze({}),
      capabilities: Object.freeze({}),
      orders: Object.freeze([]),
    });
  }
  const metadata = await stat(file);
  const signature = `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
  const cached = CACHE.get(file);
  if (!forceRefresh && cached?.signature === signature && cached.value) return cached.value;
  if (cached?.signature === signature && cached.promise) return cached.promise;
  const promise = readFile(file, 'utf8')
    .then((body) => normalizeShippingOrders(JSON.parse(body)))
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
