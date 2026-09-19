/**
 * Builds the read-only product-management index from captured WebAPI rows.
 *
 * The index is the single observable boundary for the product page.  It is
 * assembled only from allowlisted platform fields (see product-index-contracts),
 * so an unverified key can never leak in.  Identity, inventory and sales remain
 * owned by the OpenAPI fact layer; this module attaches them by reference and
 * never invents a value it did not receive: an absent platform field stays
 * absent so the UI can render it as unknown instead of zero.
 */

import {
  PRODUCT_INDEX_FIELD_ALLOWLISTS,
  PRODUCT_LEVEL_GROUPS,
  PRODUCT_SHELF_STATUSES,
  pickProductFields,
} from '../webapi-history/product-index-contracts.mjs';

export const PRODUCT_INDEX_VERSION = 1;
export const PRODUCT_INDEX_EXPECTED_STORE_COUNT = 25;

/** Site codes the operator asked to see first; order is significant. */
export const PRODUCT_PRIORITY_SITE_CODES = Object.freeze(['shein-de', 'shein-sa', 'shein-jp']);

const SITE_SHELF_STATUS_LABELS = Object.freeze({
  0: 'NOT_ON_SALE',
  1: 'ON_SALE',
});

const SITE_BAN_STATUS_LABELS = Object.freeze({
  0: 'NOT_BANNED',
  1: 'BANNED',
});

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result === '' ? null : result;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Maps one platform level name onto its stocking group.  An unrecognised name
 * is returned as UNCLASSIFIED rather than silently dropped, so a platform
 * taxonomy change surfaces as a visible bucket instead of lost volume.
 */
export function productLevelGroup(levelName) {
  const name = text(levelName);
  if (!name) return null;
  for (const [group, names] of Object.entries(PRODUCT_LEVEL_GROUPS)) {
    if (names.includes(name)) return group;
  }
  return 'UNCLASSIFIED';
}

export function productShelfStatusLabel(status) {
  const value = text(status);
  return PRODUCT_SHELF_STATUSES.includes(value) ? value : null;
}

/**
 * Counts links per stocking group.  Only the five groups the operator named are
 * returned individually; every other platform level stays inside its group so
 * the five headline numbers always reconcile with the total.
 */
export function countLevelGroups(entries) {
  const counts = { NEW: 0, STOCK_A: 0, STOCK_B: 0, GUARANTEED: 0, CLEARANCE: 0, BLOCKED: 0, UNCLASSIFIED: 0 };
  let total = 0;
  for (const entry of entries) {
    const group = productLevelGroup(entry?.goodsLevelName);
    total += 1;
    if (group && Object.prototype.hasOwnProperty.call(counts, group)) counts[group] += 1;
  }
  return Object.freeze({ ...counts, total });
}

function siteStatusValue(raw, labels) {
  const parsed = integerOrNull(raw);
  if (parsed === null) return { value: null, label: null };
  return { value: parsed, label: labels[parsed] ?? null };
}

/**
 * Normalizes one SKC's per-site rows into a bounded site map.  Unknown status
 * codes keep their raw value with a null label instead of being coerced.
 */
export function normalizeSiteStatusRows(rows) {
  const sites = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = text(row?.site_abbr);
    if (!code) continue;
    const shelf = siteStatusValue(row?.shelf_status, SITE_SHELF_STATUS_LABELS);
    const ban = siteStatusValue(row?.sell_ban_status, SITE_BAN_STATUS_LABELS);
    sites[code] = Object.freeze({
      siteCode: code,
      shelfStatus: shelf.value,
      shelfStatusLabel: shelf.label,
      sellBanStatus: ban.value,
      sellBanStatusLabel: ban.label,
    });
  }
  return Object.freeze(sites);
}

function prioritySiteView(sites) {
  const view = {};
  for (const code of PRODUCT_PRIORITY_SITE_CODES) {
    const entry = sites[code];
    view[code] = entry
      ? Object.freeze({ onSale: entry.shelfStatus === 1, shelfStatus: entry.shelfStatus, sellBanStatus: entry.sellBanStatus })
      : Object.freeze({ onSale: null, shelfStatus: null, sellBanStatus: null });
  }
  return Object.freeze(view);
}

function mapSkuRows(skuRows) {
  const skus = [];
  for (const raw of Array.isArray(skuRows) ? skuRows : []) {
    const picked = pickProductFields(raw, PRODUCT_INDEX_FIELD_ALLOWLISTS.GOODS_SKC_LIST_SKU);
    const skuCode = text(picked.skuCode);
    if (!skuCode) continue;
    skus.push(Object.freeze({
      skuCode,
      supplierSku: text(picked.supplierSku),
      attr: text(picked.attr),
      price: numberOrNull(picked.price),
      finalPrice: numberOrNull(picked.finalPrice),
      purchasePrice: numberOrNull(picked.purchasePrice),
      predictDaySales: numberOrNull(picked.predictDaySales),
      totalSaleVolume: integerOrNull(picked.totalSaleVolume),
      c7dSaleCnt: integerOrNull(picked.c7dSaleCnt),
      c30dSaleCnt: integerOrNull(picked.c30dSaleCnt),
      stock: integerOrNull(picked.stock),
      stayDeliver: integerOrNull(picked.stayDeliver),
      stayShelf: integerOrNull(picked.stayShelf),
      transit: integerOrNull(picked.transit),
      preemptionNum: integerOrNull(picked.preemptionNum),
      supplierStock: integerOrNull(picked.supplierStock),
      saleableStock: integerOrNull(picked.saleableStock),
      stockSaleDays: numberOrNull(picked.stockSaleDays),
      saleDays: numberOrNull(picked.saleDays),
      stockDays: numberOrNull(picked.stockDays),
      virtualSign: integerOrNull(picked.virtualSign),
    }));
  }
  return Object.freeze(skus);
}

function levelNameFrom(picked) {
  const level = picked && typeof picked === 'object' ? picked : {};
  return text(level.name) ?? text(level.goodsLevelName);
}

function mapGoodsSkcRow(raw) {
  const picked = pickProductFields(raw, PRODUCT_INDEX_FIELD_ALLOWLISTS.GOODS_SKC_LIST);
  const skc = text(picked.skc);
  if (!skc) return null;
  const level = pickProductFields(raw?.goodsLevel, PRODUCT_INDEX_FIELD_ALLOWLISTS.GOODS_SKC_LIST_LEVEL);
  const labels = [];
  for (const item of Array.isArray(raw?.goodsLabelList) ? raw.goodsLabelList : []) {
    const name = text(item?.businessLabelTitle) ?? text(item?.name);
    if (name) labels.push(name);
  }
  return Object.freeze({
    skc,
    spu: text(picked.spu),
    supplierCode: text(picked.supplierCode),
    categoryName: text(picked.categoryName),
    picUrl: text(picked.picUrl),
    shelfDays: integerOrNull(picked.shelfDays),
    shelfDate: text(picked.shelfDate),
    currencySymbol: text(picked.currencySymbol),
    c7dSaleCntSum: integerOrNull(picked.c7dSaleCntSum),
    goodsLevelName: levelNameFrom(level),
    goodsLevelGroup: productLevelGroup(levelNameFrom(level)),
    goodsLevelNote: text(level.note),
    goodsLevelCanOrder: picked.goodsLevelCanOrderFlag === true,
    labels: Object.freeze(labels),
    skus: mapSkuRows(raw?.skuList),
  });
}

function mapProductListRow(raw) {
  const picked = pickProductFields(raw, PRODUCT_INDEX_FIELD_ALLOWLISTS.PRODUCT_LIST);
  const skcs = [];
  for (const skcRow of Array.isArray(raw?.skc_info_list) ? raw.skc_info_list : []) {
    const skcPicked = pickProductFields(skcRow, PRODUCT_INDEX_FIELD_ALLOWLISTS.PRODUCT_LIST_SKC);
    const skcName = text(skcPicked.skc_name);
    if (!skcName) continue;
    const skuCodes = [];
    for (const skuRow of Array.isArray(skcRow?.sku_info) ? skcRow.sku_info : []) {
      const skuPicked = pickProductFields(skuRow, PRODUCT_INDEX_FIELD_ALLOWLISTS.PRODUCT_LIST_SKU);
      const code = text(skuPicked.sku_code);
      if (code) skuCodes.push(code);
    }
    skcs.push(Object.freeze({
      skcName,
      skcCode: text(skcPicked.skc_code),
      saleName: text(skcPicked.sale_name),
      supplierCode: text(skcPicked.supplier_code),
      mainImageUrl: text(skcPicked.main_image_thumbnail_url),
      businessModel: integerOrNull(skcPicked.business_model),
      mallSellStatus: integerOrNull(skcPicked.mall_sell_status),
      abandoned: skcPicked.abandoned === true,
      hasActivity: skcPicked.has_activity === true,
      hasOriginalImage: skcPicked.has_original_image === true,
      shelfFailReason: text(skcPicked.shelf_fail_reason),
      skuCodes: Object.freeze(skuCodes),
    }));
  }
  const spu = text(picked.spu_code);
  const spuName = text(picked.spu_name);
  if (!spu && !spuName && skcs.length === 0) return null;
  return Object.freeze({
    spu,
    spuName,
    productName: text(picked.product_name_ch) ?? text(picked.product_name_en),
    productNameEn: text(picked.product_name_en),
    categoryId: integerOrNull(picked.category_id),
    brandCode: text(picked.brand_code),
    brandName: text(picked.brand_name),
    shelfStatus: productShelfStatusLabel(picked.shelf_status),
    createdAt: text(picked.create_time),
    publishedAt: text(picked.publish_time),
    firstShelfAt: text(picked.first_shelf_time),
    expectShelfAt: text(picked.expect_shelf_time),
    skcs: Object.freeze(skcs),
  });
}

/**
 * Assembles the index.  `siteStatus` maps skcName -> normalized site rows and is
 * optional: a SKC with no captured site rows reports unknown site coverage
 * rather than assuming it is off sale everywhere.
 */
export function buildProductIndex({
  productListRows = [],
  goodsSkcRows = [],
  siteStatus = {},
  shelfStatusCounts = [],
  capturedAt = new Date().toISOString(),
  storeCode = null,
} = {}) {
  const products = [];
  for (const raw of productListRows) {
    const mapped = mapProductListRow(raw);
    if (mapped) products.push(mapped);
  }
  const levelEntries = [];
  for (const raw of goodsSkcRows) {
    const mapped = mapGoodsSkcRow(raw);
    if (mapped) levelEntries.push(mapped);
  }
  const counts = {};
  for (const code of PRODUCT_SHELF_STATUSES) counts[code] = null;
  for (const row of Array.isArray(shelfStatusCounts) ? shelfStatusCounts : []) {
    const code = productShelfStatusLabel(row?.shelf_status);
    const value = integerOrNull(row?.count);
    if (code && value !== null) counts[code] = value;
  }
  const sites = {};
  for (const [skcName, rows] of Object.entries(siteStatus && typeof siteStatus === 'object' ? siteStatus : {})) {
    const normalized = normalizeSiteStatusRows(rows);
    sites[skcName] = Object.freeze({
      skc: skcName,
      siteCount: Object.keys(normalized).length,
      sites: normalized,
      priority: prioritySiteView(normalized),
    });
  }
  return Object.freeze({
    schemaVersion: PRODUCT_INDEX_VERSION,
    storeCode: text(storeCode),
    capturedAt,
    shelfStatusCounts: Object.freeze(counts),
    levelGroupCounts: countLevelGroups(levelEntries),
    productCount: products.length,
    skcCount: levelEntries.length,
    siteCoverageCount: Object.keys(sites).length,
    products: Object.freeze(products),
    skcs: Object.freeze(levelEntries),
    siteCoverage: Object.freeze(sites),
  });
}

