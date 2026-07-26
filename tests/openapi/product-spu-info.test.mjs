import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchFullManagedProductSpuInfo,
  mapFullManagedProductSpuInfoResponse,
  PRODUCT_SPU_INFO_PATH,
} from '../../src/openapi/product-spu-info.mjs';

function successfulInfo(overrides = {}) {
  return {
    code: '0',
    msg: 'OK',
    traceId: 'TRACE-1',
    info: {
      spuName: 'MM2404163183',
      supplierCode: 'SUPPLIER-SPU',
      brandCode: 'BRAND-9',
      categoryId: 1980,
      productTypeId: 71,
      productMultiNameList: [
        { language: 'zh-cn', productName: '测试商品' },
        { language: 'en', productName: 'Test product' },
      ],
      productAttributeInfoList: [
        {
          attributeId: 40,
          attributeMultiList: [{ language: 'zh-cn', attributeName: '适合类型' }],
          attributeValueId: 132,
          attributeValueMultiList: [{
            language: 'zh-cn',
            attributeValueName: '男朋友',
          }],
        },
        {
          attributeId: 27,
          attributeMultiList: [{ language: 'zh-cn', attributeName: '颜色' }],
          attributeValueId: 2147484570,
          attributeValueMultiList: [{
            language: 'zh-cn',
            attributeValueName: '黑色',
          }],
        },
        {
          attributeId: 87,
          attributeMultiList: [{ language: 'zh-cn', attributeName: '尺寸' }],
          attributeValueId: 756,
          attributeValueMultiList: [{
            language: 'zh-cn',
            attributeValueName: 'XXL',
          }],
        },
      ],
      dimensionAttributeInfoList: [{
        attributeId: 9001,
        attributeMultiList: [{ language: 'zh-cn', attributeName: '胸围' }],
        dimensionAttributeAdditionList: [{
          additionValue: '88',
          relateSaleAttributeId: 87,
          relateSaleAttributeValueId: 756,
        }],
      }],
      spuImageInfoList: [{
        groupCode: 'SPU-GROUP',
        imageItemId: 9000000001,
        imageType: 'FUTURE-SPU-TYPE',
        imageUrl: 'https://img.example/spu.jpg?token=auxiliary',
        sort: '1',
      }],
      skcInfoList: [{
        skcName: 'sMM24041631833322',
        supplierCode: 'SUPPLIER-SKC',
        productMultiNameList: [{ language: 'zh-cn', productName: '黑色商品' }],
        attributeId: 27,
        attributeMultiList: [{ language: 'zh-cn', attributeName: '颜色' }],
        attributeValueId: 2147484570,
        attributeValueMultiList: [{
          language: 'zh-cn',
          attributeValueName: '黑色',
        }],
        skcImageInfoList: [{
          groupCode: 'SKC-GROUP',
          imageItemId: 9000000002,
          imageType: 'MAIN',
          imageUrl: 'https://img.example/skc.jpg',
          sort: 1,
        }],
        siteDetailImageInfoList: [{
          imageGroupCode: 'DETAIL-GROUP',
          imageInfoList: [{
            imageItemId: 9000000003,
            imageSort: 1,
            imageUrl: 'https://img.example/detail.jpg',
          }],
          siteInfoList: [{
            channel: 'future-channel',
            mainSite: 'shein',
            site: 'shein-sa',
          }],
        }],
        skuInfoList: [{
          skuCode: 'I05xh21a82o5',
          supplierSku: 'black-XXL',
          length: '11.00',
          width: '12.00',
          height: '13.00',
          weight: 222,
          mallState: 91,
          stopPurchase: 92,
          quantityType: 8,
          quantityUnit: 9,
          quantity: 2,
          packageType: 77,
          saleAttributeList: [{
            attributeId: 87,
            attributeValueId: 756,
            attributeValueMultiList: [{
              language: 'zh-cn',
              attributeValueName: 'XXL',
            }],
          }],
          skuSupplierInfo: {
            supplierBarcodeEnabled: true,
            supplierBarcodeList: [{
              barcode_type: 'EAN',
              barcode_list: ['6901234567892', '6901234567892'],
            }, {
              barcode_type: 'UPC',
              barcode_list: ['012345678905'],
            }, {
              barcode_type: 'FUTURE_BARCODE',
              barcode_list: ['RAW-123'],
            }],
          },
          skuImageInfoList: [{
            groupCode: 'SKU-GROUP',
            imageItemId: 9000000004,
            imageType: 'FUTURE-SKU-TYPE',
            imageUrl: 'https://img.example/sku.jpg',
            sort: 1,
          }],
        }],
      }],
      ...overrides,
    },
  };
}

test('goods/spu-info uses the official read-only POST request and maps layered identity evidence', async () => {
  const calls = [];
  const client = {
    async request(path, options) {
      calls.push({ path, options });
      return { data: successfulInfo() };
    },
  };

  const result = await fetchFullManagedProductSpuInfo(client, {
    spuName: 'MM2404163183',
    languageList: ['zh-cn', 'en'],
  });

  assert.deepEqual(calls, [{
    path: PRODUCT_SPU_INFO_PATH,
    options: {
      method: 'POST',
      body: {
        languageList: ['en', 'zh-cn'],
        spuName: 'MM2404163183',
      },
    },
  }]);
  assert.equal(result.spuName, 'MM2404163183');
  assert.equal(result.supplierCode, 'SUPPLIER-SPU');
  assert.equal(result.brandCode, 'BRAND-9');
  assert.equal(result.categoryId, '1980');
  assert.equal(result.productTypeId, '71');
  assert.equal(result.skcs[0].supplierCode, 'SUPPLIER-SKC');
  assert.equal(result.skcs[0].skus[0].supplierSku, 'black-XXL');
  assert.deepEqual(result.skcs[0].skus[0].packageDimensions, {
    lengthCm: '11.00',
    widthCm: '12.00',
    heightCm: '13.00',
    weightG: '222',
  });
  assert.equal(result.requestFingerprint.length, 64);
  assert.equal(result.responseFingerprint.length, 64);
});

test('product attributes remove SKC/SKU sales attributes while retaining the reported list', () => {
  const result = mapFullManagedProductSpuInfoResponse(successfulInfo(), {
    requestedSpuName: 'MM2404163183',
  });

  assert.deepEqual(
    result.reportedProductAttributes.map(({ attributeId }) => attributeId),
    ['27', '40', '87'],
  );
  assert.deepEqual(
    result.productAttributes.map(({ attributeId }) => attributeId),
    ['40'],
  );
  assert.equal(result.skcs[0].saleAttribute.attributeId, '27');
  assert.equal(result.skcs[0].skus[0].saleAttributes[0].attributeId, '87');
  assert.equal(result.dimensionAttributes[0].additions[0].value, '88');
});

test('multiple EAN/UPC barcodes are de-duplicated and unknown barcode enums are preserved', () => {
  const result = mapFullManagedProductSpuInfoResponse(successfulInfo(), {
    requestedSpuName: 'MM2404163183',
  });
  const sku = result.skcs[0].skus[0];

  assert.equal(sku.supplierBarcodeEnabled, true);
  assert.deepEqual(sku.barcodes, [
    { type: 'EAN', standard: 'EAN', value: '6901234567892' },
    { type: 'FUTURE_BARCODE', standard: null, value: 'RAW-123' },
    { type: 'UPC', standard: 'UPC', value: '012345678905' },
  ]);
  assert.equal(sku.mallStateCode, '91');
  assert.equal(sku.stopPurchaseCode, '92');
  assert.equal(sku.quantity.packageTypeCode, '77');
  assert.equal(result.images[0].typeCode, 'FUTURE-SPU-TYPE');
  assert.equal(sku.images[0].typeCode, 'FUTURE-SKU-TYPE');
});

test('image URLs remain auxiliary alongside stable image identifiers', () => {
  const result = mapFullManagedProductSpuInfoResponse(successfulInfo(), {
    requestedSpuName: 'MM2404163183',
  });

  assert.deepEqual(
    {
      groupCode: result.images[0].groupCode,
      imageItemId: result.images[0].imageItemId,
      imageUrl: result.images[0].imageUrl,
    },
    {
      groupCode: 'SPU-GROUP',
      imageItemId: '9000000001',
      imageUrl: 'https://img.example/spu.jpg?token=auxiliary',
    },
  );
  const detail = result.skcs[0].siteDetailImageGroups[0];
  assert.equal(detail.groupCode, 'DETAIL-GROUP');
  assert.equal(detail.images[0].imageItemId, '9000000003');
  assert.equal(detail.sites[0].channel, 'future-channel');
});

test('CDN hosts, paths and signed image queries never drift the identity response fingerprint', () => {
  const first = successfulInfo();
  const second = structuredClone(first);
  second.info.spuImageInfoList[0].imageUrl = (
    'https://rotated-cdn.example/new/spu.webp?signature=SECOND&expires=999'
  );
  second.info.spuImageInfoList[0].imageMediumUrl = (
    'https://thumbs.example/medium/spu.webp?token=SECOND'
  );
  second.info.skcInfoList[0].skcImageInfoList[0].imageUrl = (
    'https://rotated-cdn.example/new/skc.webp?signature=SECOND'
  );
  second.info.skcInfoList[0].siteDetailImageInfoList[0]
    .imageInfoList[0].imageUrl = (
      'https://rotated-cdn.example/new/detail.webp?signature=SECOND'
    );
  second.info.skcInfoList[0].skuInfoList[0].skuImageInfoList[0].imageUrl = (
    'https://rotated-cdn.example/new/sku.webp?signature=SECOND'
  );

  const left = mapFullManagedProductSpuInfoResponse(first, {
    requestedSpuName: 'MM2404163183',
  });
  const right = mapFullManagedProductSpuInfoResponse(second, {
    requestedSpuName: 'MM2404163183',
  });

  assert.notEqual(left.images[0].imageUrl, right.images[0].imageUrl);
  assert.notEqual(
    left.skcs[0].skus[0].images[0].imageUrl,
    right.skcs[0].skus[0].images[0].imageUrl,
  );
  assert.equal(right.responseFingerprint, left.responseFingerprint);
});

test('missing optional fields map to explicit nulls and empty arrays', async () => {
  const client = {
    async request() {
      return {
        data: {
          code: '0',
          info: { spuName: 'SPU-ONLY' },
        },
      };
    },
  };
  const result = await fetchFullManagedProductSpuInfo(client, {
    spuName: 'SPU-ONLY',
  });

  assert.deepEqual(
    {
      supplierCode: result.supplierCode,
      brandCode: result.brandCode,
      categoryId: result.categoryId,
      productTypeId: result.productTypeId,
      names: result.names,
      productAttributes: result.productAttributes,
      dimensionAttributes: result.dimensionAttributes,
      images: result.images,
      skcs: result.skcs,
      traceId: result.traceId,
    },
    {
      supplierCode: null,
      brandCode: null,
      categoryId: null,
      productTypeId: null,
      names: [],
      productAttributes: [],
      dimensionAttributes: [],
      images: [],
      skcs: [],
      traceId: null,
    },
  );
});

test('canonical output is independent of SKC, SKU and localized-name response order', () => {
  const first = successfulInfo({
    productMultiNameList: [
      { language: 'zh-cn', productName: '测试商品' },
      { language: 'en', productName: 'Test product' },
    ],
    skcInfoList: [{
      skcName: 'SKC-B',
      skuInfoList: [{ skuCode: 'SKU-B2' }, { skuCode: 'SKU-B1' }],
    }, {
      skcName: 'SKC-A',
      skuInfoList: [{ skuCode: 'SKU-A1' }],
    }],
  });
  const second = successfulInfo({
    productMultiNameList: [
      { language: 'en', productName: 'Test product' },
      { language: 'zh-cn', productName: '测试商品' },
    ],
    skcInfoList: [{
      skcName: 'SKC-A',
      skuInfoList: [{ skuCode: 'SKU-A1' }],
    }, {
      skcName: 'SKC-B',
      skuInfoList: [{ skuCode: 'SKU-B1' }, { skuCode: 'SKU-B2' }],
    }],
  });
  second.traceId = 'TRACE-2';

  const left = mapFullManagedProductSpuInfoResponse(first, {
    requestedSpuName: 'MM2404163183',
  });
  const right = mapFullManagedProductSpuInfoResponse(second, {
    requestedSpuName: 'MM2404163183',
  });
  assert.equal(left.responseFingerprint, right.responseFingerprint);
  assert.deepEqual(
    { ...left, traceId: null },
    { ...right, traceId: null },
  );
});

test('invalid request parameters fail before any network call', async () => {
  let calls = 0;
  const client = { async request() { calls += 1; } };

  for (const options of [
    {},
    { spuName: ' ' },
    { spuName: 'SPU/unsafe' },
    { spuName: 'SPU', languageList: [] },
    { spuName: 'SPU', languageList: ['zh-cn', 'ar'] },
    { spuName: 'SPU', languageList: 'zh-cn' },
  ]) {
    await assert.rejects(
      () => fetchFullManagedProductSpuInfo(client, options),
      TypeError,
    );
  }
  assert.equal(calls, 0);
});

test('platform errors retain code, message and trace evidence', async () => {
  const client = {
    async request() {
      return {
        data: {
          code: '400105',
          msg: 'SPU not approved',
          traceId: 'TRACE-ERROR',
        },
      };
    },
  };

  await assert.rejects(
    () => fetchFullManagedProductSpuInfo(client, { spuName: 'SPU-1' }),
    (error) => (
      error.code === 'PLATFORM_ERROR'
      && error.details.platformCode === '400105'
      && error.details.platformMessage === 'SPU not approved'
      && error.details.traceId === 'TRACE-ERROR'
    ),
  );
});

test('successful responses fail closed on a mismatched SPU or malformed barcode list', () => {
  assert.throws(
    () => mapFullManagedProductSpuInfoResponse(
      successfulInfo({ spuName: 'OTHER-SPU' }),
      { requestedSpuName: 'MM2404163183' },
    ),
    (error) => error.code === 'UNEXPECTED_RESPONSE_SPU',
  );

  const malformed = successfulInfo();
  malformed.info.skcInfoList[0].skuInfoList[0].skuSupplierInfo
    .supplierBarcodeList[0].barcode_list = '6901234567892';
  assert.throws(
    () => mapFullManagedProductSpuInfoResponse(malformed, {
      requestedSpuName: 'MM2404163183',
    }),
    (error) => (
      error.code === 'INVALID_RESPONSE_SHAPE'
      && /barcode_list must be an array/.test(error.message)
    ),
  );
});

test('duplicate SKC or cross-SKC SKU identifiers fail closed', () => {
  assert.throws(
    () => mapFullManagedProductSpuInfoResponse(
      successfulInfo({
        skcInfoList: [
          { skcName: 'SKC-DUPLICATE' },
          { skcName: 'SKC-DUPLICATE' },
        ],
      }),
      { requestedSpuName: 'MM2404163183' },
    ),
    (error) => error.code === 'DUPLICATE_RESPONSE_SKC',
  );

  assert.throws(
    () => mapFullManagedProductSpuInfoResponse(
      successfulInfo({
        skcInfoList: [
          { skcName: 'SKC-1', skuInfoList: [{ skuCode: 'SKU-DUPLICATE' }] },
          { skcName: 'SKC-2', skuInfoList: [{ skuCode: 'SKU-DUPLICATE' }] },
        ],
      }),
      { requestedSpuName: 'MM2404163183' },
    ),
    (error) => error.code === 'DUPLICATE_RESPONSE_SKU',
  );
});
