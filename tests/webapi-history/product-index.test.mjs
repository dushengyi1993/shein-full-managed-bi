import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCT_PRIORITY_SITE_CODES,
  buildProductIndex,
  countLevelGroups,
  normalizeSiteStatusRows,
  productLevelGroup,
  productShelfStatusLabel,
} from '../../src/webapi-history/product-index.mjs';

function productRow(overrides = {}) {
  return {
    spu_code: 'v2608301813435794',
    spu_name: 'spu-1',
    product_name_ch: '电热饭盒',
    product_name_en: 'Lunch Box',
    brand_code: 'SMEGGEMS',
    shelf_status: 'ON_SHELF',
    create_time: '2026/08/30 18:30:10',
    publish_time: '2026/08/31 10:32:45',
    first_shelf_time: '2026/09/14 14:09:20',
    secret_token: 'must-not-leak',
    skc_info_list: [{
      skc_name: 'sv260830181343579432818',
      supplier_code: 'MZ-电热饭盒白色',
      main_image_thumbnail_url: 'https://x/y.jpg',
      abandoned: false,
      has_activity: true,
      sku_info: [{ sku_code: 'I1' }, { sku_code: 'I2' }],
    }],
    ...overrides,
  };
}

function goodsSkcRow(overrides = {}) {
  return {
    skc: 'sv1',
    spu: 'v1',
    supplierCode: 'MZ-1',
    categoryName: '厨房',
    shelfDays: 6,
    shelfDate: '2026-09-14',
    currencySymbol: 'CNY',
    c7dSaleCntSum: 12,
    goodsLevel: { name: '备货款A', note: '热销' },
    goodsLevelCanOrderFlag: true,
    goodsLabelList: [{ businessLabelTitle: '中东高销款' }],
    skuList: [{
      skuCode: 'I1',
      price: '52.00',
      purchasePrice: '31.50',
      predictDaySales: 9.1,
      c7dSaleCnt: 40,
      c30dSaleCnt: 240,
      stock: 17,
      stayDeliver: 0,
      stayShelf: 0,
      transit: 0,
      preemptionNum: 127,
      contactPhone: '13800000000',
    }],
    ...overrides,
  };
}

test('platform level names fold into stocking groups without overlap', () => {
  assert.equal(productLevelGroup('新款'), 'NEW');
  assert.equal(productLevelGroup('新款A'), 'NEW');
  assert.equal(productLevelGroup('备货款A'), 'STOCK_A');
  assert.equal(productLevelGroup('备货款B'), 'STOCK_B');
  assert.equal(productLevelGroup('备货款C'), 'STOCK_B');
  assert.equal(productLevelGroup('保证在售款'), 'GUARANTEED');
  assert.equal(productLevelGroup('退供款'), 'CLEARANCE');
  assert.equal(productLevelGroup('QQK'), 'BLOCKED');
  assert.equal(productLevelGroup('未来新层次'), 'UNCLASSIFIED');
  assert.equal(productLevelGroup(''), null);
  assert.equal(productLevelGroup(null), null);
});

test('an unrecognised platform level is surfaced, not dropped', () => {
  const counts = countLevelGroups([
    { goodsLevelName: '新款' },
    { goodsLevelName: '备货款A' },
    { goodsLevelName: '未来新层次' },
    { goodsLevelName: null },
  ]);
  assert.equal(counts.NEW, 1);
  assert.equal(counts.STOCK_A, 1);
  assert.equal(counts.UNCLASSIFIED, 1);
  assert.equal(counts.total, 4, 'every entry is counted so the five headline numbers reconcile');
});

test('shelf status labels accept only captured platform values', () => {
  for (const code of ['ALL', 'ON_SHELF', 'WAIT_SHELF', 'OUT_SHELF', 'SOLD_OUT']) {
    assert.equal(productShelfStatusLabel(code), code);
  }
  assert.equal(productShelfStatusLabel('UNKNOWN_STATUS'), null);
  assert.equal(productShelfStatusLabel(''), null);
  assert.equal(productShelfStatusLabel(null), null);
});

test('site coverage keeps raw codes when the label is unknown', () => {
  const sites = normalizeSiteStatusRows([
    { site_abbr: 'shein-de', shelf_status: 0, sell_ban_status: 1 },
    { site_abbr: 'shein-sa', shelf_status: 1, sell_ban_status: 1 },
    { site_abbr: 'shein-jp', shelf_status: 1, sell_ban_status: 1 },
    { site_abbr: 'shein-xx', shelf_status: 7, sell_ban_status: 9 },
    { site_abbr: '', shelf_status: 1 },
  ]);
  assert.equal(Object.keys(sites).length, 4, 'blank site codes are dropped');
  assert.equal(sites['shein-de'].shelfStatusLabel, 'NOT_ON_SALE');
  assert.equal(sites['shein-sa'].shelfStatusLabel, 'ON_SALE');
  assert.equal(sites['shein-xx'].shelfStatus, 7, 'unknown code keeps its raw value');
  assert.equal(sites['shein-xx'].shelfStatusLabel, null);
  assert.equal(sites['shein-xx'].sellBanStatusLabel, null);
});

test('the index never projects a non-allowlisted field', () => {
  const index = buildProductIndex({
    productListRows: [productRow()],
    goodsSkcRows: [goodsSkcRow()],
    storeCode: 'DL',
  });
  const serialized = JSON.stringify(index);
  for (const forbidden of ['secret_token', 'must-not-leak', 'contactPhone', '13800000000']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not enter the index`);
  }
});

test('the index attaches level, label, price and priority sites per SKC', () => {
  const index = buildProductIndex({
    productListRows: [productRow()],
    goodsSkcRows: [goodsSkcRow()],
    siteStatus: {
      sv1: [
        { site_abbr: 'shein-de', shelf_status: 0, sell_ban_status: 1 },
        { site_abbr: 'shein-sa', shelf_status: 1, sell_ban_status: 1 },
        { site_abbr: 'shein-jp', shelf_status: 1, sell_ban_status: 1 },
      ],
    },
    shelfStatusCounts: [
      { shelf_status: 'ON_SHELF', count: 87 },
      { shelf_status: 'ALL', count: 253 },
    ],
    storeCode: 'DL',
  });
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.productCount, 1);
  assert.equal(index.skcCount, 1);
  assert.equal(index.shelfStatusCounts.ON_SHELF, 87);
  assert.equal(index.shelfStatusCounts.ALL, 253);
  assert.equal(index.shelfStatusCounts.WAIT_SHELF, null, 'an uncaptured status stays unknown, not zero');
  const skc = index.skcs[0];
  assert.equal(skc.goodsLevelName, '备货款A');
  assert.equal(skc.goodsLevelGroup, 'STOCK_A');
  assert.deepEqual([...skc.labels], ['中东高销款']);
  assert.equal(skc.shelfDays, 6);
  assert.equal(skc.skus[0].price, 52);
  assert.equal(skc.skus[0].purchasePrice, 31.5);
  assert.equal(skc.skus[0].predictDaySales, 9.1);
  assert.equal(skc.skus[0].c30dSaleCnt, 240);
  assert.equal(skc.skus[0].stock, 17);
  assert.equal(skc.skus[0].contactPhone, undefined);
  assert.equal(index.levelGroupCounts.STOCK_A, 1);
  assert.equal(index.levelGroupCounts.total, 1);
  const coverage = index.siteCoverage.sv1;
  assert.equal(coverage.siteCount, 3);
  assert.deepEqual([...PRODUCT_PRIORITY_SITE_CODES], ['shein-de', 'shein-sa', 'shein-jp']);
  assert.equal(coverage.priority['shein-de'].onSale, false);
  assert.equal(coverage.priority['shein-sa'].onSale, true);
  assert.equal(coverage.priority['shein-jp'].onSale, true);
});

test('a SKC with no captured site rows reports unknown coverage, never off-sale', () => {
  const index = buildProductIndex({ goodsSkcRows: [goodsSkcRow()] });
  assert.equal(index.siteCoverageCount, 0);
  const partial = buildProductIndex({
    goodsSkcRows: [goodsSkcRow()],
    siteStatus: { sv1: [{ site_abbr: 'shein-de', shelf_status: 1, sell_ban_status: 1 }] },
  });
  assert.equal(partial.siteCoverage.sv1.priority['shein-sa'].onSale, null, 'a missing site is unknown, not false');
  assert.equal(partial.siteCoverage.sv1.priority['shein-de'].onSale, true);
});

test('the index tolerates empty and malformed platform payloads', () => {
  const empty = buildProductIndex({});
  assert.equal(empty.productCount, 0);
  assert.equal(empty.skcCount, 0);
  assert.equal(empty.levelGroupCounts.total, 0);
  const malformed = buildProductIndex({
    productListRows: [null, 'x', { skc_info_list: 'nope' }, {}],
    goodsSkcRows: [null, {}, { skc: '' }],
    siteStatus: { sv1: 'nope' },
    shelfStatusCounts: [null, { shelf_status: 'BOGUS', count: 1 }],
  });
  assert.equal(malformed.productCount, 0);
  assert.equal(malformed.skcCount, 0);
  assert.equal(malformed.siteCoverage.sv1.siteCount, 0);
  assert.equal(malformed.shelfStatusCounts.ON_SHELF, null);
});

