import {
  ORDER_MANAGEMENT_EXPECTED_STORE_COUNT,
  ORDER_MANAGEMENT_PAGE_IDS,
  assertAllowlistedFieldName,
  containsNumericPii,
  isDeniedKeyName,
  scrubPiiText,
  validateOrderManagementIndex,
  validateOrderManagementRow,
} from '../order-management/order-management-contract.mjs';
import { ORDER_MANAGEMENT_SESSION_PAGES } from '../webapi-history/order-management-contracts.mjs';

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

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).normalize('NFKC').trim();
  return normalized || null;
}

function joinLimited(values, { maximum = 12, separator = '|' } = {}) {
  const unique = [...new Set(values.map((value) => text(value)).filter(Boolean))];
  if (unique.length === 0) return null;
  if (unique.length <= maximum) return unique.join(separator);
  return `${unique.slice(0, maximum).join(separator)}…`;
}

/**
 * Fail-closed delivery status derivation from the OpenAPI fact columns.
 * The ordering is intentionally conservative: the latest confirmed stage
 * wins.
 */
export function deriveDeliveryStatus(delivery) {
  if (delivery.received_at) return Object.freeze({ code: 'RECEIVED', name: '已收货' });
  if (delivery.taken_at) return Object.freeze({ code: 'TAKEN', name: '已取货' });
  if (delivery.reserved_parcel_at) return Object.freeze({ code: 'RESERVED', name: '已预约取件' });
  return Object.freeze({ code: 'PENDING', name: '待取货' });
}

export function deriveWaybillStatus(waybill) {
  if (waybill.signTime) return Object.freeze({ code: 'SIGNED', name: '已签收' });
  if (waybill.pickupTime) return Object.freeze({ code: 'IN_TRANSIT', name: '运输中' });
  if (waybill.reservedParcelAt) return Object.freeze({ code: 'RESERVED', name: '已预约取件' });
  return Object.freeze({ code: 'PENDING_PICKUP', name: '待取件' });
}

function metric(pageId, name, value) {
  assertAllowlistedFieldName(pageId, name);
  const normalized = nullableNumber(value);
  return Object.freeze({ name, value: normalized });
}

function fact(pageId, name, value) {
  assertAllowlistedFieldName(pageId, name);
  const normalized = scrubPiiText(value);
  if (normalized === null) return null;
  return Object.freeze({ name, value: normalized.slice(0, 512) });
}

function detail(pageId, name, value) {
  assertAllowlistedFieldName(pageId, name);
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Object.freeze({ name, value });
  const normalized = scrubPiiText(value);
  if (normalized === null) return null;
  return Object.freeze({ name, value: normalized.slice(0, 256) });
}

export const ORDER_MANAGEMENT_SQL = Object.freeze({
  deliveries: `
    SELECT d.delivery_id, d.store_id, s.store_code,
           d.delivery_code, d.delivery_type_code, d.delivery_type_name,
           d.express_code, d.express_company_code, d.express_company_name,
           d.package_count, d.package_weight,
           d.warehouse_code, d.warehouse_name,
           d.platform_created_at, d.reserved_parcel_at, d.taken_at,
           d.expected_receipt_at, d.received_at, d.source_fetched_at
    FROM fact.delivery AS d
    JOIN dim.store AS s ON s.store_id = d.store_id
    WHERE s.is_active = true
    ORDER BY d.platform_created_at DESC NULLS LAST,
             s.store_code, d.delivery_code`,
  lines: `
    SELECT line.store_id, line.delivery_id,
           line.order_no, line.skc_name, line.sku_code,
           line.delivery_quantity, line.source_fetched_at
    FROM fact.delivery_line AS line
    WHERE line.is_current
    ORDER BY line.store_id, line.delivery_id, line.source_line_key`,
  orders: `
    SELECT order_no, store_id,
           order_type_code, order_type_name,
           status_code, status_name,
           prepare_type_code, prepare_type_name
    FROM fact.purchase_order
    ORDER BY store_id, order_no`,
});

function emptyPage(pageId, source, reason, { now } = {}) {
  return Object.freeze({
    status: 'UNAVAILABLE',
    source,
    latestSourceFetchedAt: null,
    reason,
    rows: Object.freeze([]),
  });
}

function lineGroupKey(storeId, deliveryId) {
  return `${String(storeId)}\u001f${String(deliveryId)}`;
}

function buildDeliveryNoteRow(delivery, lines, orderLookup) {
  const status = deriveDeliveryStatus(delivery);
  const orderNos = lines.map((line) => line.order_no).filter(Boolean);
  const orderTypeNames = [...new Set(orderNos
    .map((orderNo) => orderLookup.get(`${delivery.store_id}\u001f${orderNo}`)?.order_type_name)
    .filter(Boolean))];
  const details = [];
  for (const line of lines.slice(0, 16)) {
    for (const entry of [
      detail('delivery-notes', 'orderNo', line.order_no),
      detail('delivery-notes', 'skcName', line.skc_name),
      detail('delivery-notes', 'skuCode', line.sku_code),
      detail('delivery-notes', 'deliveryQuantity', line.delivery_quantity),
    ]) {
      if (entry !== null) details.push(entry);
    }
  }
  return Object.freeze({
    id: delivery.delivery_code,
    storeCode: delivery.store_code,
    statusCode: status.code,
    statusName: status.name,
    createdAt: isoInstant(delivery.platform_created_at),
    updatedAt: isoInstant(delivery.source_fetched_at),
    primary: delivery.delivery_code,
    secondary: joinLimited(orderNos),
    tags: Object.freeze(['发货单', delivery.delivery_type_name].filter(Boolean)),
    metrics: Object.freeze([
      metric('delivery-notes', 'packageCount', delivery.package_count),
      metric('delivery-notes', 'packageWeight', delivery.package_weight),
      metric('delivery-notes', 'lineCount', lines.length),
      metric('delivery-notes', 'skuCount', new Set(lines.map((line) => line.sku_code).filter(Boolean)).size),
      metric('delivery-notes', 'orderCount', new Set(orderNos).size),
      metric('delivery-notes', 'deliveryQuantity', lines.reduce(
        (sum, line) => sum + (nullableInteger(line.delivery_quantity) ?? 0),
        0,
      )),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      fact('delivery-notes', 'deliveryTypeName', delivery.delivery_type_name),
      fact('delivery-notes', 'expressCompanyName', delivery.express_company_name),
      fact('delivery-notes', 'expressCode', delivery.express_code),
      fact('delivery-notes', 'warehouseName', delivery.warehouse_name),
      fact('delivery-notes', 'orderTypeName', joinLimited(orderTypeNames)),
      fact('delivery-notes', 'reservedParcelAt', isoInstant(delivery.reserved_parcel_at)),
      fact('delivery-notes', 'takenAt', isoInstant(delivery.taken_at)),
      fact('delivery-notes', 'expectedReceiptAt', isoInstant(delivery.expected_receipt_at)),
      fact('delivery-notes', 'receivedAt', isoInstant(delivery.received_at)),
    ].filter(Boolean)),
    details: Object.freeze(details),
  });
}

function buildWaybillCoreRow(delivery, lines) {
  if (!delivery.express_code) return null;
  const status = deriveWaybillStatus({
    signTime: delivery.received_at,
    pickupTime: delivery.taken_at,
    reservedParcelAt: delivery.reserved_parcel_at,
  });
  const orderNos = lines.map((line) => line.order_no).filter(Boolean);
  const details = [];
  for (const line of lines.slice(0, 16)) {
    for (const entry of [
      detail('waybills', 'orderNo', line.order_no),
      detail('waybills', 'skcName', line.skc_name),
      detail('waybills', 'skuCode', line.sku_code),
      detail('waybills', 'deliveryQuantity', line.delivery_quantity),
    ]) {
      if (entry !== null) details.push(entry);
    }
  }
  return Object.freeze({
    id: delivery.express_code,
    storeCode: delivery.store_code,
    statusCode: status.code,
    statusName: status.name,
    createdAt: isoInstant(delivery.platform_created_at),
    updatedAt: isoInstant(delivery.source_fetched_at),
    primary: delivery.express_code,
    secondary: delivery.delivery_code,
    tags: Object.freeze(['发货运单核心', delivery.delivery_type_name].filter(Boolean)),
    metrics: Object.freeze([
      metric('waybills', 'packageCount', delivery.package_count),
      metric('waybills', 'packageWeight', delivery.package_weight),
      metric('waybills', 'lineCount', lines.length),
      metric('waybills', 'deliveryQuantity', lines.reduce(
        (sum, line) => sum + (nullableInteger(line.delivery_quantity) ?? 0),
        0,
      )),
    ].filter((entry) => entry.value !== null)),
    facts: Object.freeze([
      fact('waybills', 'deliveryCode', delivery.delivery_code),
      fact('waybills', 'expressCompanyName', delivery.express_company_name),
      fact('waybills', 'orderNo', joinLimited(orderNos)),
      fact('waybills', 'skcName', joinLimited(lines.map((line) => line.skc_name))),
      fact('waybills', 'reservedParcelAt', isoInstant(delivery.reserved_parcel_at)),
      fact('waybills', 'takenAt', isoInstant(delivery.taken_at)),
      fact('waybills', 'expectedReceiptAt', isoInstant(delivery.expected_receipt_at)),
      fact('waybills', 'receivedAt', isoInstant(delivery.received_at)),
    ].filter(Boolean)),
    details: Object.freeze(details),
  });
}

function validateRows(pageId, rows, label) {
  const errors = [];
  rows.forEach((row, index) => {
    const check = validateOrderManagementRow(row, { pageId });
    if (!check.ok) {
      check.errors.forEach((message) => errors.push(`${label}[${index}] ${message}`));
    }
  });
  return errors;
}

/**
 * Materialize the fact-backed core pages (delivery-notes, waybills) from one
 * repeatable-read database snapshot.  Only explicitly selected columns are
 * read; the fact tables already exclude address/contact/phone data.
 */
export async function materializeOrderManagementDatabasePages(pool, {
  now = new Date(),
  expectedStoreCount = ORDER_MANAGEMENT_EXPECTED_STORE_COUNT,
} = {}) {
  if (!pool?.connect) throw new TypeError('A PostgreSQL pool is required.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout TO '120s'");
    const deliveriesResult = await client.query(ORDER_MANAGEMENT_SQL.deliveries);
    const linesResult = await client.query(ORDER_MANAGEMENT_SQL.lines);
    const ordersResult = await client.query(ORDER_MANAGEMENT_SQL.orders);
    await client.query('COMMIT');

    const orderLookup = new Map();
    for (const order of ordersResult.rows) {
      if (!order.order_no) continue;
      orderLookup.set(`${order.store_id}\u001f${order.order_no}`, order);
    }
    const linesByDelivery = new Map();
    for (const line of linesResult.rows) {
      const key = lineGroupKey(line.store_id, line.delivery_id);
      if (!linesByDelivery.has(key)) linesByDelivery.set(key, []);
      linesByDelivery.get(key).push(line);
    }

    const deliveryNoteRows = [];
    const waybillCoreRows = [];
    const deliveryNoteSeen = new Set();
    const waybillSeen = new Set();
    for (const delivery of deliveriesResult.rows) {
      const lines = linesByDelivery.get(lineGroupKey(delivery.store_id, delivery.delivery_id)) ?? [];
      const noteKey = `${delivery.store_code}\u001f${delivery.delivery_code}`;
      if (!deliveryNoteSeen.has(noteKey)) {
        deliveryNoteSeen.add(noteKey);
        deliveryNoteRows.push(buildDeliveryNoteRow(delivery, lines, orderLookup));
      }
      if (delivery.express_code) {
        const waybillKey = `${delivery.store_code}\u001f${delivery.express_code}`;
        if (!waybillSeen.has(waybillKey)) {
          waybillSeen.add(waybillKey);
          const row = buildWaybillCoreRow(delivery, lines);
          if (row !== null) waybillCoreRows.push(row);
        }
      }
    }

    const deliveryNoteErrors = validateRows('delivery-notes', deliveryNoteRows, 'delivery-notes');
    const waybillErrors = validateRows('waybills', waybillCoreRows, 'waybills');
    if (deliveryNoteErrors.length || waybillErrors.length) {
      throw new TypeError([
        'ORDER_MANAGEMENT_ROW_INVALID',
        ...deliveryNoteErrors,
        ...waybillErrors,
      ].join('\n'));
    }

    const latestFetched = (rows) => rows
      .map((row) => row.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    const storeCodes = (rows) => [...new Set(rows.map((row) => row.storeCode).filter(Boolean))].sort();
    const waybillEligibleCount = deliveriesResult.rows
      .filter((delivery) => delivery.express_code).length;
    const deliveryNoteStores = storeCodes(deliveryNoteRows);
    const waybillStores = storeCodes(waybillCoreRows);

    const deliveryNotesPage = Object.freeze({
      status: deliveryNoteStores.length === expectedStoreCount ? 'AVAILABLE' : 'PARTIAL',
      source: 'OPENAPI_FACT_DATABASE',
      latestSourceFetchedAt: latestFetched(deliveryNoteRows),
      reason: deliveryNoteStores.length === expectedStoreCount
        ? null
        : `DATABASE_STORE_COVERAGE_INCOMPLETE: fact.delivery covers ${deliveryNoteStores.length}/${expectedStoreCount} stores; sync supply data for the full roster before promotion.`,
      rows: Object.freeze(deliveryNoteRows),
    });
    const waybillsPage = Object.freeze({
      status: waybillStores.length === expectedStoreCount ? 'AVAILABLE' : 'PARTIAL',
      source: 'OPENAPI_FACT_DATABASE',
      latestSourceFetchedAt: latestFetched(waybillCoreRows),
      reason: waybillStores.length === expectedStoreCount
        ? null
        : `DATABASE_STORE_COVERAGE_INCOMPLETE: fact.delivery (express_code) covers ${waybillStores.length}/${expectedStoreCount} stores; sync supply data for the full roster before promotion.`,
      rows: Object.freeze(waybillCoreRows),
    });

    return Object.freeze({
      now: now.toISOString(),
      pages: Object.freeze({
        'delivery-notes': deliveryNotesPage,
        waybills: waybillsPage,
      }),
      evidence: Object.freeze({
        'delivery-notes': Object.freeze({
          gates: Object.freeze({
            totalVerified: true,
            pagingVerified: true,
            dedupeVerified: true,
            basis: 'REPEATABLE_READ_DB_SNAPSHOT',
          }),
          storeCodes: Object.freeze(deliveryNoteStores),
          rowCount: deliveryNoteRows.length,
          skippedDuplicates: deliveriesResult.rows.length - deliveryNoteRows.length,
        }),
        waybills: Object.freeze({
          gates: Object.freeze({
            totalVerified: true,
            pagingVerified: true,
            dedupeVerified: true,
            basis: 'REPEATABLE_READ_DB_SNAPSHOT',
          }),
          storeCodes: Object.freeze(waybillStores),
          rowCount: waybillCoreRows.length,
          skippedDuplicates: waybillEligibleCount - waybillCoreRows.length,
        }),
      }),
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the root error */ }
    throw error;
  } finally {
    client.release();
  }
}

function normalizeSnapshotPage(page, pageId, { now, expectedStoreCount } = {}) {
  const fallback = emptyPage(pageId, 'SESSION_HTTP', 'SESSION_SNAPSHOT_PAGE_MISSING', { now });
  if (!page || typeof page !== 'object') {
    return Object.freeze({ page: fallback, storeCodes: Object.freeze([]) });
  }
  const gatePassed = page.gates
    && page.gates.totalVerified === true
    && page.gates.pagingVerified === true
    && page.gates.dedupeVerified === true
    && page.gates.contentVerified !== false
    && Number.isSafeInteger(page.gates.storeCount)
    && page.gates.storeCount === expectedStoreCount;
  const rows = Array.isArray(page.rows) ? page.rows : [];
  const declaredStoreCodes = Array.isArray(page.storeCodes)
    ? [...new Set(page.storeCodes.filter((code) => typeof code === 'string' && code))].sort()
    : [];
  const storeCodes = declaredStoreCodes.length > 0
    ? declaredStoreCodes
    : [...new Set(rows.map((row) => row.storeCode).filter(Boolean))].sort();
  const rowErrors = validateRows(pageId, rows, `${pageId}/session`);
  if (rowErrors.length) {
    return Object.freeze({
      page: Object.freeze({
        status: 'PARTIAL',
        source: 'SESSION_HTTP',
        latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
        reason: `SESSION_SNAPSHOT_ROW_INVALID: ${rowErrors[0]}`,
        rows: Object.freeze([]),
      }),
      storeCodes,
    });
  }
  if (page.status === 'UNAVAILABLE') {
    return Object.freeze({
      page: Object.freeze({
        status: 'UNAVAILABLE',
        source: 'SESSION_HTTP',
        latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
        reason: page.reason ?? 'SESSION_GATE_FAILED: no store produced a complete page.',
        rows: Object.freeze([]),
      }),
      storeCodes,
    });
  }
  if (page.status !== 'AVAILABLE' || !gatePassed) {
    return Object.freeze({
      page: Object.freeze({
        status: 'PARTIAL',
        source: 'SESSION_HTTP',
        latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
        reason: page.reason
          ?? 'SESSION_GATE_FAILED: total/paging/dedupe/25-store coverage gate did not pass in the snapshot.',
        rows: Object.freeze(rows),
      }),
      storeCodes,
    });
  }
  return Object.freeze({
    page: Object.freeze({
      status: 'AVAILABLE',
      source: 'SESSION_HTTP',
      latestSourceFetchedAt: page.latestSourceFetchedAt ?? null,
      reason: null,
      rows: Object.freeze(rows),
    }),
    storeCodes,
  });
}

/**
 * Merge a session snapshot produced by sync_full_managed_order_management_sessions.mjs.
 * The materializer never issues live session requests itself; without a
 * snapshot the session pages stay UNAVAILABLE.
 */
export function mergeOrderManagementSessionSnapshot(snapshot, {
  now = new Date(),
  expectedStoreCount = ORDER_MANAGEMENT_EXPECTED_STORE_COUNT,
  waybillCoreRows = [],
} = {}) {
  const hasSnapshot = Boolean(snapshot && typeof snapshot === 'object' && snapshot.pages);
  const sessionPageIds = Object.keys(ORDER_MANAGEMENT_SESSION_PAGES);
  const absentReason = 'SESSION_SNAPSHOT_ABSENT: run scripts/sync_full_managed_order_management_sessions.mjs with --execute to produce the snapshot; the materializer never guesses a live request.';
  const normalizedByPage = {};
  const pages = {};
  const evidence = {};

  for (const pageId of sessionPageIds) {
    if (pageId === 'waybills') continue;
    const normalized = hasSnapshot
      ? normalizeSnapshotPage(snapshot.pages?.[pageId], pageId, { now, expectedStoreCount })
      : Object.freeze({
          page: emptyPage(pageId, 'SESSION_HTTP', absentReason, { now }),
          storeCodes: Object.freeze([]),
        });
    normalizedByPage[pageId] = normalized;
    pages[pageId] = normalized.page;
    evidence[pageId] = Object.freeze({
      gates: normalized.page.status === 'AVAILABLE'
        ? Object.freeze({ totalVerified: true, pagingVerified: true, dedupeVerified: true, contentVerified: true })
        : Object.freeze({ totalVerified: false, pagingVerified: false, dedupeVerified: false, contentVerified: false }),
      storeCodes: Object.freeze(normalized.storeCodes),
      rowCount: normalized.page.rows.length,
      skippedDuplicates: 0,
      sessionSnapshotUsed: hasSnapshot,
    });
  }

  const stockPage = pages['stock-records'];
  const stockNormalized = normalizedByPage['stock-records'];

  const waybillNormalized = hasSnapshot
    ? normalizeSnapshotPage(snapshot.pages?.waybills, 'waybills', { now, expectedStoreCount })
    : Object.freeze({
        page: emptyPage('waybills', 'SESSION_HTTP', absentReason, { now }),
        storeCodes: Object.freeze([]),
      });
  const waybillSessionPage = waybillNormalized.page;

  const seen = new Set();
  const mergedWaybillRows = [];
  let sessionDedupeSkipped = 0;
  for (const row of waybillCoreRows) {
    const key = `${row.storeCode}\u001f${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mergedWaybillRows.push(row);
  }
  for (const row of waybillSessionPage.rows) {
    const key = `${row.storeCode}\u001f${row.id}`;
    if (seen.has(key)) {
      sessionDedupeSkipped += 1;
      continue;
    }
    seen.add(key);
    mergedWaybillRows.push(row);
  }

  const waybillErrors = validateRows('waybills', mergedWaybillRows, 'waybills/merged');
  if (waybillErrors.length) {
    throw new TypeError(`ORDER_MANAGEMENT_ROW_INVALID\n${waybillErrors.join('\n')}`);
  }
  const waybillStores = [...new Set([
    ...waybillCoreRows.map((row) => row.storeCode).filter(Boolean),
    ...waybillNormalized.storeCodes,
  ])].sort();
  const sessionMerged = waybillSessionPage.status === 'AVAILABLE'
    || waybillSessionPage.status === 'PARTIAL';
  const waybillsPage = waybillSessionPage.status === 'PARTIAL'
    ? Object.freeze({
        status: 'PARTIAL',
        source: 'OPENAPI_FACT_DATABASE_SESSION_MERGED',
        latestSourceFetchedAt: [
          waybillSessionPage.latestSourceFetchedAt,
          ...mergedWaybillRows.map((row) => row.updatedAt),
        ].filter(Boolean).sort().at(-1) ?? null,
        reason: waybillSessionPage.reason
          ?? 'SESSION_GATE_FAILED: the waybill session snapshot page did not pass its gates.',
        rows: Object.freeze(mergedWaybillRows),
      })
    : Object.freeze({
        status: waybillStores.length === expectedStoreCount ? 'AVAILABLE' : 'PARTIAL',
        source: sessionMerged ? 'OPENAPI_FACT_DATABASE_SESSION_MERGED' : 'OPENAPI_FACT_DATABASE',
        latestSourceFetchedAt: [
          waybillSessionPage.latestSourceFetchedAt,
          ...mergedWaybillRows.map((row) => row.updatedAt),
        ].filter(Boolean).sort().at(-1) ?? null,
        reason: waybillStores.length === expectedStoreCount
          ? null
          : `STORE_COVERAGE_INCOMPLETE: waybills cover ${waybillStores.length}/${expectedStoreCount} stores across fact.delivery and the session snapshot.`,
        rows: Object.freeze(mergedWaybillRows),
      });

  return Object.freeze({
    now: now.toISOString(),
    pages: Object.freeze({
      ...pages,
      waybills: waybillsPage,
    }),
    evidence: Object.freeze({
      'stock-records': Object.freeze({
        gates: stockPage.status === 'AVAILABLE'
          ? Object.freeze({ totalVerified: true, pagingVerified: true, dedupeVerified: true, contentVerified: true })
          : Object.freeze({ totalVerified: false, pagingVerified: false, dedupeVerified: false, contentVerified: false }),
        storeCodes: Object.freeze(stockNormalized.storeCodes),
        rowCount: stockPage.rows.length,
        skippedDuplicates: 0,
        sessionSnapshotUsed: hasSnapshot,
      }),
      waybills: Object.freeze({
        gates: waybillsPage.status === 'AVAILABLE'
          ? Object.freeze({ totalVerified: true, pagingVerified: true, dedupeVerified: true, contentVerified: true })
          : Object.freeze({ totalVerified: false, pagingVerified: false, dedupeVerified: false, contentVerified: false }),
        storeCodes: Object.freeze(waybillStores),
        rowCount: mergedWaybillRows.length,
        skippedDuplicates: sessionDedupeSkipped,
        sessionSnapshotUsed: hasSnapshot,
      }),
      ...Object.fromEntries(
        sessionPageIds
          .filter((pageId) => pageId !== 'stock-records' && pageId !== 'waybills')
          .map((pageId) => [pageId, evidence[pageId]]),
      ),
    }),
  });
}

function intersectionOf(pageEntries) {
  const pages = pageEntries.filter(Boolean);
  if (pages.length === 0) return [];
  const counts = new Map();
  for (const entry of pages) {
    for (const storeCode of new Set(entry.storeCodes)) {
      counts.set(storeCode, (counts.get(storeCode) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count === pages.length)
    .map(([storeCode]) => storeCode)
    .sort();
}

/**
 * Orchestrator: fact-backed core pages + session snapshot pages + the fixed
 * UNAVAILABLE pages, then the shared coverage and promotion gate.
 */
export async function materializeOrderManagement({
  pool,
  sessionSnapshot = null,
  now = new Date(),
  expectedStoreCount = ORDER_MANAGEMENT_EXPECTED_STORE_COUNT,
} = {}) {
  if (!pool?.connect) throw new TypeError('A PostgreSQL pool is required.');
  const database = await materializeOrderManagementDatabasePages(pool, {
    now,
    expectedStoreCount,
  });
  const session = mergeOrderManagementSessionSnapshot(sessionSnapshot, {
    now,
    expectedStoreCount,
    waybillCoreRows: database.pages.waybills.rows,
  });

  const pages = {};
  const evidencePages = {};
  for (const [pageId, page] of Object.entries(database.pages)) {
    pages[pageId] = page;
    evidencePages[pageId] = database.evidence[pageId];
  }
  for (const [pageId, page] of Object.entries(session.pages)) {
    pages[pageId] = page;
    evidencePages[pageId] = session.evidence[pageId];
  }
  for (const pageId of ORDER_MANAGEMENT_PAGE_IDS) {
    if (pages[pageId]) continue;
    pages[pageId] = emptyPage(
      pageId,
      'NONE',
      'NO_VERIFIED_SOURCE: no database page or session snapshot page produced this page id.',
      { now },
    );
    evidencePages[pageId] = Object.freeze({
      gates: Object.freeze({
        totalVerified: false,
        pagingVerified: false,
        dedupeVerified: false,
      }),
      storeCodes: Object.freeze([]),
      rowCount: 0,
      skippedDuplicates: 0,
    });
  }

  const availablePages = ORDER_MANAGEMENT_PAGE_IDS
    .filter((pageId) => pages[pageId].status === 'AVAILABLE');
  const partialPages = ORDER_MANAGEMENT_PAGE_IDS
    .filter((pageId) => pages[pageId].status === 'PARTIAL');
  const unavailablePages = ORDER_MANAGEMENT_PAGE_IDS
    .filter((pageId) => pages[pageId].status === 'UNAVAILABLE');
  const storeCodes = intersectionOf(availablePages.map((pageId) => evidencePages[pageId]));
  const completed = availablePages.length === 0
    ? 0
    : storeCodes.length;
  const everyPageAvailable = availablePages.length === ORDER_MANAGEMENT_PAGE_IDS.length;
  const coverageStatus = availablePages.length === 0 && partialPages.length === 0
    ? 'UNAVAILABLE'
    : everyPageAvailable && partialPages.length === 0 && completed === expectedStoreCount
      ? 'COMPLETE'
      : 'PARTIAL';
  const coverageReason = coverageStatus === 'COMPLETE'
    ? null
    : partialPages.length > 0
      ? `PAGE_GATE_FAILED: ${partialPages.map((pageId) => `${pageId}: ${pages[pageId].reason}`).join(' | ')}`
      : unavailablePages.length > 0
        ? `PAGE_UNAVAILABLE: ${unavailablePages.map((pageId) => `${pageId}: ${pages[pageId].reason}`).join(' | ')}`
      : availablePages.length === 0
        ? 'NO_AVAILABLE_PAGES: every page is UNAVAILABLE; nothing can be promoted.'
        : `STORE_COVERAGE_INCOMPLETE: ${completed}/${expectedStoreCount} stores covered by every available page.`;

  const index = Object.freeze({
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    coverage: Object.freeze({
      status: coverageStatus,
      expectedStoreCount,
      completedStoreCount: completed,
      storeCodes: Object.freeze(storeCodes),
      reason: coverageReason,
    }),
    promotable: coverageStatus === 'COMPLETE',
    pages: Object.freeze(pages),
    evidence: Object.freeze({
      pages: Object.freeze(evidencePages),
    }),
  });

  const validation = validateOrderManagementIndex(index);
  if (!validation.ok) {
    throw new TypeError(`ORDER_MANAGEMENT_INDEX_INVALID\n${validation.errors.join('\n')}`);
  }
  return index;
}
