import {
  buildReportingGoodsLookup,
  resolveReportingGoodsAssignment,
} from './dashboard-materializer.mjs';

function isoInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function nullableInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).normalize('NFKC').trim();
  return normalized || null;
}

export const SHIPPING_ORDERS_SQL = Object.freeze({
  orders: `
    SELECT po.purchase_order_id, po.store_id, store.store_code, store.store_name,
           po.order_no, po.order_type_code, po.order_type_name,
           po.status_code, po.status_name,
           po.prepare_type_code, po.prepare_type_name,
           po.category_code, po.category_name, po.currency_code,
           po.warehouse_code, po.warehouse_name, po.jit_role_code,
           po.platform_created_at, po.platform_updated_at,
           po.requested_delivery_at, po.requested_receipt_at,
           po.delivered_at, po.received_at, po.stored_at,
           po.source_fetched_at
    FROM fact.purchase_order AS po
    JOIN dim.store AS store ON store.store_id = po.store_id
    WHERE store.is_active = true
    ORDER BY po.platform_created_at DESC NULLS LAST,
             store.store_code, po.order_no`,
  lines: `
    SELECT line.purchase_order_id, line.store_id, line.source_line_key,
           line.sku_code, line.skc_name, line.supplier_code, line.supplier_sku,
           line.variant_name, line.need_quantity, line.order_quantity,
           line.delivery_quantity, line.receipt_quantity,
           line.storage_quantity, line.defective_quantity,
           line.request_delivery_quantity, line.no_request_delivery_quantity,
           line.already_delivery_quantity, line.source_fetched_at
    FROM fact.purchase_order_line AS line
    WHERE line.is_current
    ORDER BY line.purchase_order_id, line.source_line_key`,
  deliveries: `
    SELECT delivery.store_id, delivery.delivery_code,
           delivery.delivery_type_code, delivery.delivery_type_name,
           delivery.express_code, delivery.express_company_name,
           delivery.warehouse_code, delivery.warehouse_name,
           delivery.reserved_parcel_at, delivery.taken_at,
           delivery.expected_receipt_at, delivery.received_at,
           delivery.source_fetched_at,
           line.order_no, line.skc_name, line.sku_code,
           line.delivery_quantity
    FROM fact.delivery AS delivery
    JOIN fact.delivery_line AS line
      ON line.store_id = delivery.store_id
     AND line.delivery_id = delivery.delivery_id
     AND line.is_current
    WHERE line.order_no IS NOT NULL
    ORDER BY delivery.store_id, line.order_no, delivery.delivery_code`,
  reportingGoods: `
    SELECT store.store_code,
           sku.platform_sku_id, sku.platform_skc_id, sku.platform_spu_id,
           sku.supplier_code, sku.supplier_sku,
           goods.standard_goods_code, goods.display_name,
           goods.model_normalized, goods.naming_rule,
           assignment.confidence_band, assignment.source_plan_hash
    FROM dim.full_sku_reporting_goods_assignment AS assignment
    JOIN dim.full_sku AS sku
      ON sku.store_id = assignment.store_id
     AND sku.full_sku_id = assignment.full_sku_id
    JOIN dim.store AS store ON store.store_id = assignment.store_id
    JOIN dim.reporting_goods AS goods
      ON goods.reporting_goods_id = assignment.reporting_goods_id
    WHERE assignment.assignment_status = 'CONFIRMED'
      AND assignment.valid_to IS NULL
      AND goods.status = 'ACTIVE'
      AND sku.is_active = true
      AND store.is_active = true
    ORDER BY store.store_code, sku.full_sku_id`,
});

function lineValue(row, reportingGoodsLookup, storeCode) {
  const assignment = resolveReportingGoodsAssignment(reportingGoodsLookup, {
    storeCode,
    platformSkuId: row.sku_code,
    platformSkcId: row.skc_name,
    supplierCode: row.supplier_code,
    supplierSku: row.supplier_sku,
  });
  return Object.freeze({
    lineKey: text(row.source_line_key),
    skuCode: text(row.sku_code),
    skc: text(row.skc_name),
    supplierCode: text(row.supplier_code),
    supplierSku: text(row.supplier_sku),
    variantName: text(row.variant_name),
    standardGoodsCode: assignment?.standardGoodsCode ?? null,
    standardGoodsName: assignment?.standardGoodsName ?? null,
    needQuantity: nullableInteger(row.need_quantity),
    orderQuantity: nullableInteger(row.order_quantity),
    deliveryQuantity: nullableInteger(row.delivery_quantity),
    receiptQuantity: nullableInteger(row.receipt_quantity),
    storageQuantity: nullableInteger(row.storage_quantity),
    defectiveQuantity: nullableInteger(row.defective_quantity),
    requestedDeliveryQuantity: nullableInteger(row.request_delivery_quantity),
    pendingDeliveryQuantity: nullableInteger(row.no_request_delivery_quantity),
    alreadyDeliveryQuantity: nullableInteger(row.already_delivery_quantity),
    sourceFetchedAt: isoInstant(row.source_fetched_at),
  });
}

function deliveryValue(row) {
  return Object.freeze({
    deliveryCode: text(row.delivery_code),
    deliveryTypeCode: text(row.delivery_type_code),
    deliveryTypeName: text(row.delivery_type_name),
    expressCode: text(row.express_code),
    expressCompanyName: text(row.express_company_name),
    warehouseCode: text(row.warehouse_code),
    warehouseName: text(row.warehouse_name),
    reservedParcelAt: isoInstant(row.reserved_parcel_at),
    takenAt: isoInstant(row.taken_at),
    expectedReceiptAt: isoInstant(row.expected_receipt_at),
    receivedAt: isoInstant(row.received_at),
    sourceFetchedAt: isoInstant(row.source_fetched_at),
    deliveryQuantity: nullableInteger(row.delivery_quantity),
    skuCode: text(row.sku_code),
    skc: text(row.skc_name),
  });
}

function nullableSum(rows, field) {
  if (!rows.length || rows.some((row) => row[field] === null)) return null;
  return rows.reduce((sum, row) => sum + row[field], 0);
}

/** Materialize a read-only, full-order search index separate from dashboard.json. */
export async function materializeShippingOrdersFromDatabase(pool, { now = new Date() } = {}) {
  if (!pool?.connect) throw new TypeError('A PostgreSQL pool is required.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout TO '120s'");
    const schema = await client.query(`
      SELECT to_regclass('dim.reporting_goods') IS NOT NULL AS has_reporting_goods,
             to_regclass('dim.full_sku_reporting_goods_assignment') IS NOT NULL
               AS has_reporting_goods_assignment`);
    // One PostgreSQL client is intentionally used sequentially so all three
    // reads share the same repeatable-read snapshot without hidden query
    // queuing or driver-specific concurrency behaviour.
    const ordersResult = await client.query(SHIPPING_ORDERS_SQL.orders);
    const linesResult = await client.query(SHIPPING_ORDERS_SQL.lines);
    const deliveriesResult = await client.query(SHIPPING_ORDERS_SQL.deliveries);
    const reportingAvailable = schema.rows[0]?.has_reporting_goods === true
      && schema.rows[0]?.has_reporting_goods_assignment === true;
    const reportingResult = reportingAvailable
      ? await client.query(SHIPPING_ORDERS_SQL.reportingGoods)
      : { rows: [] };
    await client.query('COMMIT');

    const reportingGoodsLookup = buildReportingGoodsLookup(reportingResult.rows);
    const orderByIdentity = new Map();
    const orderById = new Map();
    for (const row of ordersResult.rows) {
      const order = {
        storeCode: text(row.store_code),
        storeName: text(row.store_name),
        orderNo: text(row.order_no),
        orderTypeCode: text(row.order_type_code),
        orderTypeName: text(row.order_type_name),
        statusCode: text(row.status_code),
        statusName: text(row.status_name),
        prepareTypeCode: text(row.prepare_type_code),
        prepareTypeName: text(row.prepare_type_name),
        categoryCode: text(row.category_code),
        categoryName: text(row.category_name),
        currencyCode: text(row.currency_code),
        warehouseCode: text(row.warehouse_code),
        warehouseName: text(row.warehouse_name),
        jitRoleCode: text(row.jit_role_code),
        createdAt: isoInstant(row.platform_created_at),
        updatedAt: isoInstant(row.platform_updated_at),
        requestedDeliveryAt: isoInstant(row.requested_delivery_at),
        requestedReceiptAt: isoInstant(row.requested_receipt_at),
        deliveredAt: isoInstant(row.delivered_at),
        receivedAt: isoInstant(row.received_at),
        storedAt: isoInstant(row.stored_at),
        sourceFetchedAt: isoInstant(row.source_fetched_at),
        lines: [],
        deliveries: [],
      };
      orderById.set(String(row.purchase_order_id), order);
      orderByIdentity.set(`${row.store_id}\u001f${order.orderNo}`, order);
    }
    for (const row of linesResult.rows) {
      const order = orderById.get(String(row.purchase_order_id));
      if (!order) continue;
      order.lines.push(lineValue(row, reportingGoodsLookup, order.storeCode));
    }
    const seenDelivery = new Set();
    for (const row of deliveriesResult.rows) {
      const order = orderByIdentity.get(`${row.store_id}\u001f${text(row.order_no)}`);
      if (!order) continue;
      const key = `${row.store_id}\u001f${order.orderNo}\u001f${row.delivery_code}\u001f${row.sku_code ?? ''}`;
      if (seenDelivery.has(key)) continue;
      seenDelivery.add(key);
      order.deliveries.push(deliveryValue(row));
    }

    let latestSourceFetchedAt = null;
    const orders = [...orderById.values()].map((order) => {
      const instants = [
        order.sourceFetchedAt,
        ...order.lines.map((line) => line.sourceFetchedAt),
        ...order.deliveries.map((delivery) => delivery.sourceFetchedAt),
      ].filter(Boolean).sort();
      const latest = instants.at(-1) ?? null;
      if (latest && (!latestSourceFetchedAt || latest > latestSourceFetchedAt)) {
        latestSourceFetchedAt = latest;
      }
      const totals = Object.freeze({
        lineCount: order.lines.length,
        skcCount: new Set(order.lines.map((line) => line.skc).filter(Boolean)).size,
        needQuantity: nullableSum(order.lines, 'needQuantity'),
        orderQuantity: nullableSum(order.lines, 'orderQuantity'),
        deliveryQuantity: nullableSum(order.lines, 'deliveryQuantity'),
        receiptQuantity: nullableSum(order.lines, 'receiptQuantity'),
        storageQuantity: nullableSum(order.lines, 'storageQuantity'),
        defectiveQuantity: nullableSum(order.lines, 'defectiveQuantity'),
      });
      return Object.freeze({
        ...order,
        latestSourceFetchedAt: latest,
        totals,
        lines: Object.freeze(order.lines),
        deliveries: Object.freeze(order.deliveries),
      });
    });

    return Object.freeze({
      schemaVersion: 1,
      updatedAt: now.toISOString(),
      source: Object.freeze({
        basis: 'OPENAPI_PURCHASE_ORDER_AND_DELIVERY',
        latestSourceFetchedAt,
        storeCount: new Set(orders.map((order) => order.storeCode).filter(Boolean)).size,
        orderCount: orders.length,
        lineCount: linesResult.rows.length,
        reportingGoodsAvailable: reportingAvailable,
      }),
      capabilities: Object.freeze({
        coreOrderFacts: true,
        deliveryFacts: true,
        reportingGoods: reportingAvailable,
        portalExtensions: false,
      }),
      orders: Object.freeze(orders),
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the root error */ }
    throw error;
  } finally {
    client.release();
  }
}
