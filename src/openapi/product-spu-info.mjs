import { SheinOpenApiError } from './shein-client.mjs';
import { payloadFingerprint } from './paginated-fetch.mjs';

export const PRODUCT_SPU_INFO_PATH = '/open-api/goods/spu-info';

const SUPPORTED_LANGUAGES = new Set([
  'de',
  'en',
  'es',
  'fr',
  'ja',
  'ko',
  'pt-br',
  'th',
  'zh-cn',
]);

function responseError(message, details = {}) {
  throw new SheinOpenApiError('INVALID_RESPONSE_SHAPE', message, details);
}

function record(value, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    responseError(`${location} must be an object`);
  }
  return value;
}

function optionalArray(value, location) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) responseError(`${location} must be an array`);
  return value;
}

function optionalText(value, location) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    responseError(`${location} must be text`);
  }
  if (
    typeof value === 'number'
    && (!Number.isFinite(value) || !Number.isSafeInteger(value))
  ) {
    responseError(`${location} must be a safe scalar value`);
  }
  return String(value).trim() || null;
}

function requiredText(value, location) {
  const result = optionalText(value, location);
  if (!result) responseError(`${location} is required`);
  return result;
}

function optionalBoolean(value, location) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') responseError(`${location} must be a boolean`);
  return value;
}

function compareText(left, right) {
  const a = left ?? '';
  const b = right ?? '';
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortBy(items, key) {
  return Object.freeze([...items].sort((left, right) => compareText(key(left), key(right))));
}

function normalizedSpuName(value) {
  if (typeof value !== 'string') {
    throw new TypeError('spuName must be a string');
  }
  const spuName = value.trim();
  if (
    !spuName
    || spuName.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spuName)
  ) {
    throw new TypeError(
      'spuName must be a non-empty SHEIN identifier using only letters, digits, dot, underscore or hyphen',
    );
  }
  return spuName;
}

function normalizedLanguageList(value) {
  if (!Array.isArray(value)) throw new TypeError('languageList must be an array');
  if (value.length === 0 || value.length > 5) {
    throw new TypeError('languageList must contain from 1 to 5 languages');
  }
  const languages = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string' || value[index].trim() === '') {
      throw new TypeError(`languageList[${index}] must be a supported language`);
    }
    const language = value[index].trim().toLowerCase();
    if (!SUPPORTED_LANGUAGES.has(language)) {
      throw new TypeError(`languageList[${index}] is not supported by goods/spu-info`);
    }
    languages.add(language);
  }
  return [...languages].sort(compareText);
}

function localizedValues(value, location, fieldName) {
  const rows = optionalArray(value, location);
  const seen = new Set();
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = record(rows[index], `${location}[${index}]`);
    const language = optionalText(row.language, `${location}[${index}].language`);
    const text = optionalText(row[fieldName], `${location}[${index}].${fieldName}`);
    if (text === null) continue;
    const key = `${language ?? ''}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ language, value: text }));
  }
  return sortBy(result, (item) => `${item.language ?? ''}\u0000${item.value}`);
}

function mapAttribute(value, location) {
  const row = record(value, location);
  return Object.freeze({
    attributeId: optionalText(row.attributeId, `${location}.attributeId`),
    names: localizedValues(
      row.attributeMultiList,
      `${location}.attributeMultiList`,
      'attributeName',
    ),
    valueId: optionalText(row.attributeValueId, `${location}.attributeValueId`),
    valueText: optionalText(row.attributeValue, `${location}.attributeValue`),
    values: localizedValues(
      row.attributeValueMultiList,
      `${location}.attributeValueMultiList`,
      'attributeValueName',
    ),
  });
}

function attributeSortKey(attribute) {
  return [
    attribute.attributeId ?? '',
    attribute.valueId ?? '',
    attribute.valueText ?? '',
    JSON.stringify(attribute.names),
    JSON.stringify(attribute.values),
  ].join('\u0000');
}

function mapAttributes(value, location) {
  return sortBy(
    optionalArray(value, location)
      .map((row, index) => mapAttribute(row, `${location}[${index}]`)),
    attributeSortKey,
  );
}

function mapDimensionAttributes(value, location) {
  const dimensions = optionalArray(value, location).map((valueRow, index) => {
    const rowLocation = `${location}[${index}]`;
    const row = record(valueRow, rowLocation);
    const additions = optionalArray(
      row.dimensionAttributeAdditionList,
      `${rowLocation}.dimensionAttributeAdditionList`,
    ).map((additionValue, additionIndex) => {
      const additionLocation = `${rowLocation}.dimensionAttributeAdditionList[${additionIndex}]`;
      const addition = record(additionValue, additionLocation);
      return Object.freeze({
        value: optionalText(addition.additionValue, `${additionLocation}.additionValue`),
        relateSaleAttributeId: optionalText(
          addition.relateSaleAttributeId,
          `${additionLocation}.relateSaleAttributeId`,
        ),
        relateSaleAttributeValueId: optionalText(
          addition.relateSaleAttributeValueId,
          `${additionLocation}.relateSaleAttributeValueId`,
        ),
      });
    });
    return Object.freeze({
      attributeId: optionalText(row.attributeId, `${rowLocation}.attributeId`),
      names: localizedValues(
        row.attributeMultiList,
        `${rowLocation}.attributeMultiList`,
        'attributeName',
      ),
      additions: sortBy(
        additions,
        (addition) => [
          addition.relateSaleAttributeId ?? '',
          addition.relateSaleAttributeValueId ?? '',
          addition.value ?? '',
        ].join('\u0000'),
      ),
    });
  });
  return sortBy(
    dimensions,
    (dimension) => [
      dimension.attributeId ?? '',
      JSON.stringify(dimension.names),
      JSON.stringify(dimension.additions),
    ].join('\u0000'),
  );
}

function imageSortKey(image) {
  const numericSort = image.sort !== null && /^-?\d+(?:\.\d+)?$/.test(image.sort)
    ? String(Number(image.sort)).padStart(24, '0')
    : image.sort ?? '';
  return [
    numericSort,
    image.groupCode ?? '',
    image.imageItemId ?? '',
    image.typeCode ?? '',
    image.imageUrl ?? '',
    image.imageMediumUrl ?? '',
    image.imageSmallUrl ?? '',
  ].join('\u0000');
}

function mapImages(value, location, {
  groupField = 'groupCode',
  sortField = 'sort',
} = {}) {
  const images = optionalArray(value, location).map((imageValue, index) => {
    const imageLocation = `${location}[${index}]`;
    const image = record(imageValue, imageLocation);
    return Object.freeze({
      groupCode: optionalText(image[groupField], `${imageLocation}.${groupField}`),
      imageItemId: optionalText(image.imageItemId, `${imageLocation}.imageItemId`),
      typeCode: optionalText(image.imageType, `${imageLocation}.imageType`),
      sort: optionalText(image[sortField], `${imageLocation}.${sortField}`),
      // URLs are auxiliary retrieval evidence only. They are not image-content
      // fingerprints and must never become strong product-identity evidence.
      imageUrl: optionalText(image.imageUrl, `${imageLocation}.imageUrl`),
      imageMediumUrl: optionalText(
        image.imageMediumUrl,
        `${imageLocation}.imageMediumUrl`,
      ),
      imageSmallUrl: optionalText(
        image.imageSmallUrl,
        `${imageLocation}.imageSmallUrl`,
      ),
    });
  });
  return sortBy(images, imageSortKey);
}

function mapSiteDetailImageGroups(value, location) {
  const groups = optionalArray(value, location).map((groupValue, groupIndex) => {
    const groupLocation = `${location}[${groupIndex}]`;
    const group = record(groupValue, groupLocation);
    const sites = optionalArray(
      group.siteInfoList,
      `${groupLocation}.siteInfoList`,
    ).map((siteValue, siteIndex) => {
      const siteLocation = `${groupLocation}.siteInfoList[${siteIndex}]`;
      const site = record(siteValue, siteLocation);
      return Object.freeze({
        channel: optionalText(site.channel, `${siteLocation}.channel`),
        mainSite: optionalText(site.mainSite, `${siteLocation}.mainSite`),
        site: optionalText(site.site, `${siteLocation}.site`),
      });
    });
    return Object.freeze({
      groupCode: optionalText(group.imageGroupCode, `${groupLocation}.imageGroupCode`),
      images: mapImages(
        group.imageInfoList,
        `${groupLocation}.imageInfoList`,
        { groupField: '__absentGroupCode', sortField: 'imageSort' },
      ),
      sites: sortBy(
        sites,
        (site) => [site.channel ?? '', site.mainSite ?? '', site.site ?? ''].join('\u0000'),
      ),
    });
  });
  return sortBy(
    groups,
    (group) => [
      group.groupCode ?? '',
      JSON.stringify(group.sites),
      JSON.stringify(group.images),
    ].join('\u0000'),
  );
}

function stableImageReferenceFacts(images) {
  return sortBy(
    images.map((image) => Object.freeze({
      groupCode: image.groupCode,
      imageItemId: image.imageItemId,
      typeCode: image.typeCode,
      sort: image.sort,
    })),
    (image) => JSON.stringify(image),
  );
}

function stableSiteDetailImageFacts(groups) {
  return sortBy(
    groups.map((group) => Object.freeze({
      groupCode: group.groupCode,
      images: stableImageReferenceFacts(group.images),
      sites: group.sites,
    })),
    (group) => JSON.stringify(group),
  );
}

/**
 * Build the immutable identity-response facts used for exact replay.
 *
 * Image URLs remain available on the returned mapped response for in-process
 * auxiliary use, but never enter this payload. CDN host/path changes, signed
 * query parameters, and thumbnail URL rotation therefore cannot drift the
 * source identity fingerprint.
 */
function stableIdentityResponseFacts(facts) {
  return Object.freeze({
    ...facts,
    images: stableImageReferenceFacts(facts.images),
    skcs: Object.freeze(facts.skcs.map((skc) => Object.freeze({
      ...skc,
      images: stableImageReferenceFacts(skc.images),
      siteDetailImageGroups: stableSiteDetailImageFacts(
        skc.siteDetailImageGroups,
      ),
      skus: Object.freeze(skc.skus.map((sku) => Object.freeze({
        ...sku,
        images: stableImageReferenceFacts(sku.images),
      }))),
    }))),
  });
}

function mapSkuBarcodes(value, location) {
  if (value === undefined || value === null) {
    return Object.freeze({ supplierBarcodeEnabled: null, barcodes: Object.freeze([]) });
  }
  const supplierInfo = record(value, location);
  const barcodes = [];
  const seen = new Set();
  const barcodeGroups = optionalArray(
    supplierInfo.supplierBarcodeList,
    `${location}.supplierBarcodeList`,
  );
  for (let groupIndex = 0; groupIndex < barcodeGroups.length; groupIndex += 1) {
    const groupLocation = `${location}.supplierBarcodeList[${groupIndex}]`;
    const group = record(barcodeGroups[groupIndex], groupLocation);
    const type = optionalText(
      group.barcode_type ?? group.barcodeType,
      `${groupLocation}.barcode_type`,
    );
    const barcodeValues = group.barcode_list ?? group.barcodeList;
    const values = optionalArray(barcodeValues, `${groupLocation}.barcode_list`);
    for (let barcodeIndex = 0; barcodeIndex < values.length; barcodeIndex += 1) {
      const barcode = requiredText(
        values[barcodeIndex],
        `${groupLocation}.barcode_list[${barcodeIndex}]`,
      );
      const standard = ['EAN', 'UPC'].includes(type?.toUpperCase())
        ? type.toUpperCase()
        : null;
      const key = `${type ?? ''}\u0000${barcode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      barcodes.push(Object.freeze({ type, standard, value: barcode }));
    }
  }
  return Object.freeze({
    supplierBarcodeEnabled: optionalBoolean(
      supplierInfo.supplierBarcodeEnabled,
      `${location}.supplierBarcodeEnabled`,
    ),
    barcodes: sortBy(
      barcodes,
      (barcode) => [barcode.type ?? '', barcode.value].join('\u0000'),
    ),
  });
}

function mapSaleAttributeFromFields(row, location) {
  const names = localizedValues(
    row.attributeMultiList,
    `${location}.attributeMultiList`,
    'attributeName',
  );
  const values = localizedValues(
    row.attributeValueMultiList,
    `${location}.attributeValueMultiList`,
    'attributeValueName',
  );
  const attributeId = optionalText(row.attributeId, `${location}.attributeId`);
  const valueId = optionalText(row.attributeValueId, `${location}.attributeValueId`);
  if (attributeId === null && valueId === null && names.length === 0 && values.length === 0) {
    return null;
  }
  return Object.freeze({
    attributeId,
    names,
    valueId,
    values,
  });
}

function mapSku(value, location) {
  const row = record(value, location);
  const supplier = mapSkuBarcodes(row.skuSupplierInfo, `${location}.skuSupplierInfo`);
  return Object.freeze({
    skuCode: requiredText(row.skuCode, `${location}.skuCode`),
    // Keep the official seller-maintained SKU as-is. This adapter never maps
    // legacy productNumber (which is absent from this API) to a MODEL identity.
    supplierSku: optionalText(row.supplierSku, `${location}.supplierSku`),
    saleAttributes: sortBy(
      optionalArray(row.saleAttributeList, `${location}.saleAttributeList`)
        .map((attribute, index) => {
          const attributeLocation = `${location}.saleAttributeList[${index}]`;
          return mapSaleAttributeFromFields(record(attribute, attributeLocation), attributeLocation);
        })
        .filter(Boolean),
      (attribute) => [
        attribute.attributeId ?? '',
        attribute.valueId ?? '',
        JSON.stringify(attribute.values),
      ].join('\u0000'),
    ),
    packageDimensions: Object.freeze({
      lengthCm: optionalText(row.length, `${location}.length`),
      widthCm: optionalText(row.width, `${location}.width`),
      heightCm: optionalText(row.height, `${location}.height`),
      weightG: optionalText(row.weight, `${location}.weight`),
    }),
    mallStateCode: optionalText(row.mallState, `${location}.mallState`),
    stopPurchaseCode: optionalText(row.stopPurchase, `${location}.stopPurchase`),
    quantity: Object.freeze({
      typeCode: optionalText(row.quantityType, `${location}.quantityType`),
      unitCode: optionalText(row.quantityUnit, `${location}.quantityUnit`),
      value: optionalText(row.quantity, `${location}.quantity`),
      packageTypeCode: optionalText(row.packageType, `${location}.packageType`),
    }),
    supplierBarcodeEnabled: supplier.supplierBarcodeEnabled,
    barcodes: supplier.barcodes,
    images: mapImages(row.skuImageInfoList, `${location}.skuImageInfoList`),
  });
}

function mapSkc(value, location) {
  const row = record(value, location);
  const skus = optionalArray(row.skuInfoList, `${location}.skuInfoList`)
    .map((sku, index) => mapSku(sku, `${location}.skuInfoList[${index}]`));
  const seenSkuCodes = new Set();
  for (const sku of skus) {
    if (seenSkuCodes.has(sku.skuCode)) {
      throw new SheinOpenApiError(
        'DUPLICATE_RESPONSE_SKU',
        `${PRODUCT_SPU_INFO_PATH} returned duplicate SKU ${sku.skuCode} in one SKC`,
        { skuCode: sku.skuCode },
      );
    }
    seenSkuCodes.add(sku.skuCode);
  }
  return Object.freeze({
    skcName: requiredText(row.skcName, `${location}.skcName`),
    supplierCode: optionalText(row.supplierCode, `${location}.supplierCode`),
    names: localizedValues(
      row.productMultiNameList,
      `${location}.productMultiNameList`,
      'productName',
    ),
    saleAttribute: mapSaleAttributeFromFields(row, location),
    images: mapImages(row.skcImageInfoList, `${location}.skcImageInfoList`),
    siteDetailImageGroups: mapSiteDetailImageGroups(
      row.siteDetailImageInfoList,
      `${location}.siteDetailImageInfoList`,
    ),
    skus: sortBy(skus, (sku) => sku.skuCode),
  });
}

function successfulBody(value) {
  const body = record(value, 'response');
  if (String(body.code) !== '0') {
    throw new SheinOpenApiError(
      'PLATFORM_ERROR',
      `${PRODUCT_SPU_INFO_PATH} returned platform error ${String(body.code)}`,
      {
        platformCode: body.code === undefined ? null : String(body.code),
        platformMessage: optionalText(body.msg, 'response.msg')?.slice(0, 240) ?? null,
        traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
      },
    );
  }
  return body;
}

/**
 * Map the successful JSON body from the official goods/spu-info endpoint.
 * All arrays are canonicalized so identical platform facts produce identical
 * output fingerprints even if SHEIN changes response ordering.
 */
export function mapFullManagedProductSpuInfoResponse(
  responseBody,
  { requestedSpuName } = {},
) {
  const requested = normalizedSpuName(requestedSpuName);
  const body = successfulBody(responseBody);
  const info = record(body.info, 'response.info');
  const returnedSpuName = requiredText(info.spuName, 'response.info.spuName');
  if (returnedSpuName !== requested) {
    throw new SheinOpenApiError(
      'UNEXPECTED_RESPONSE_SPU',
      `${PRODUCT_SPU_INFO_PATH} returned SPU ${returnedSpuName} for ${requested}`,
      { requestedSpuName: requested, returnedSpuName },
    );
  }

  const skcs = optionalArray(info.skcInfoList, 'response.info.skcInfoList')
    .map((skc, index) => mapSkc(skc, `response.info.skcInfoList[${index}]`));
  const seenSkcs = new Set();
  const seenSkus = new Map();
  for (const skc of skcs) {
    if (seenSkcs.has(skc.skcName)) {
      throw new SheinOpenApiError(
        'DUPLICATE_RESPONSE_SKC',
        `${PRODUCT_SPU_INFO_PATH} returned duplicate SKC ${skc.skcName}`,
        { skcName: skc.skcName },
      );
    }
    seenSkcs.add(skc.skcName);
    for (const sku of skc.skus) {
      const previousSkc = seenSkus.get(sku.skuCode);
      if (previousSkc !== undefined) {
        throw new SheinOpenApiError(
          'DUPLICATE_RESPONSE_SKU',
          `${PRODUCT_SPU_INFO_PATH} returned SKU ${sku.skuCode} under multiple SKCs`,
          { skuCode: sku.skuCode, firstSkc: previousSkc, repeatedSkc: skc.skcName },
        );
      }
      seenSkus.set(sku.skuCode, skc.skcName);
    }
  }

  const canonicalSkcs = sortBy(skcs, (skc) => skc.skcName);
  const saleAttributeIds = new Set();
  for (const skc of canonicalSkcs) {
    if (skc.saleAttribute?.attributeId) {
      saleAttributeIds.add(skc.saleAttribute.attributeId);
    }
    for (const sku of skc.skus) {
      for (const attribute of sku.saleAttributes) {
        if (attribute.attributeId) saleAttributeIds.add(attribute.attributeId);
      }
    }
  }

  const reportedProductAttributes = mapAttributes(
    info.productAttributeInfoList,
    'response.info.productAttributeInfoList',
  );
  const facts = Object.freeze({
    spuName: returnedSpuName,
    supplierCode: optionalText(info.supplierCode, 'response.info.supplierCode'),
    brandCode: optionalText(info.brandCode, 'response.info.brandCode'),
    categoryId: optionalText(info.categoryId, 'response.info.categoryId'),
    productTypeId: optionalText(info.productTypeId, 'response.info.productTypeId'),
    names: localizedValues(
      info.productMultiNameList,
      'response.info.productMultiNameList',
      'productName',
    ),
    reportedProductAttributes,
    productAttributes: Object.freeze(
      reportedProductAttributes.filter(
        (attribute) => (
          attribute.attributeId === null
          || !saleAttributeIds.has(attribute.attributeId)
        ),
      ),
    ),
    dimensionAttributes: mapDimensionAttributes(
      info.dimensionAttributeInfoList,
      'response.info.dimensionAttributeInfoList',
    ),
    images: mapImages(info.spuImageInfoList, 'response.info.spuImageInfoList'),
    skcs: canonicalSkcs,
  });
  return Object.freeze({
    ...facts,
    traceId: optionalText(body.traceId, 'response.traceId')?.slice(0, 128) ?? null,
    responseFingerprint: payloadFingerprint(stableIdentityResponseFacts(facts)),
  });
}

/**
 * Query one approved full-managed SPU through the current official read-only
 * POST endpoint. No price, inventory or write endpoint is touched.
 */
export async function fetchFullManagedProductSpuInfo(client, {
  spuName,
  languageList = ['zh-cn'],
} = {}) {
  if (!client || typeof client.request !== 'function') {
    throw new TypeError('client.request must be a function');
  }
  const requestedSpuName = normalizedSpuName(spuName);
  const languages = normalizedLanguageList(languageList);
  const requestBody = Object.freeze({
    languageList: languages,
    spuName: requestedSpuName,
  });
  const response = await client.request(PRODUCT_SPU_INFO_PATH, {
    method: 'POST',
    body: requestBody,
  });
  const mapped = mapFullManagedProductSpuInfoResponse(response?.data, {
    requestedSpuName,
  });
  return Object.freeze({
    ...mapped,
    requestFingerprint: payloadFingerprint(requestBody),
  });
}
