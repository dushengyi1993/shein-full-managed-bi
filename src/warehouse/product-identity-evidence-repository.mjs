import {
  payloadFingerprint,
  stableJson,
} from '../openapi/paginated-fetch.mjs';
import {
  isValidGtin,
  normalizeIdentifierValue,
} from '../domain/product-identity.mjs';

const CAPABILITY_CODE = 'FULL_MANAGED_PRODUCT_IDENTITY';
const ENDPOINT_CODE = 'goods.spu-info';
const SOURCE_SYSTEM = 'SHEIN_OPENAPI_GOODS_SPU_INFO_V27';
const MODEL_ATTRIBUTE_ID = '1000546';
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_PERSISTED_TEXT = (
  /(?:https?:\/\/|authorization|bearer\s+|x-api-key|access[_-]?token|client[_-]?secret|signature|cookie)/i
);

const ATTRIBUTE_CLASSIFIERS = Object.freeze([
  {
    identifierType: 'VOLTAGE',
    pattern: /(?:^|\s)(?:rated\s*)?voltage(?:\s|$)|电压|電壓|额定电压|額定電壓/i,
  },
  {
    identifierType: 'PLUG',
    pattern: /(?:^|\s)plug(?:\s*(?:type|standard))?(?:\s|$)|插头|插頭|插座类型|插座類型/i,
  },
  {
    identifierType: 'CAPACITY',
    pattern: /(?:^|\s)(?:capacity|volume)(?:\s|$)|容量|容积|容積/i,
  },
]);

function requirePool(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('pool.connect must be a function');
  }
  return pool;
}

function requireStoreCode(value) {
  if (
    typeof value !== 'string'
    || !/^[A-Z0-9_-]+$/.test(value.trim())
  ) {
    throw new TypeError('storeCode must be an uppercase store identifier');
  }
  return value.trim();
}

function requireRunId(value) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9._:-]{8,120}$/.test(value)
  ) {
    throw new TypeError('runId must be 8-120 safe identifier characters');
  }
  return value;
}

function requireMapperVersion(value) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9._:-]{1,80}$/.test(value)
  ) {
    throw new TypeError('mapperVersion must be 1-80 safe identifier characters');
  }
  return value;
}

function requireDocumentVersion(value) {
  if (value !== 27) {
    throw new TypeError('documentVersion must be the pinned official version 27');
  }
  return value;
}

function requireInstant(value, location) {
  if (typeof value !== 'string') {
    throw new TypeError(`${location} must be an ISO date-time string`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new TypeError(`${location} must be an ISO date-time string`);
  }
  return parsed.toISOString();
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).normalize('NFKC').trim();
  return result || null;
}

function requireSourceIdentifier(value, location) {
  const result = optionalText(value);
  if (!result || result.length > 256 || FORBIDDEN_PERSISTED_TEXT.test(result)) {
    throw new TypeError(`${location} must be a safe non-empty source identifier`);
  }
  return result;
}

function requireFingerprint(value, location) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError(`${location} must be a lowercase SHA-256 fingerprint`);
  }
  return value;
}

function safeEvidenceText(value, maximum = 512) {
  const result = optionalText(value);
  if (
    !result
    || result.length > maximum
    || FORBIDDEN_PERSISTED_TEXT.test(result)
  ) {
    return null;
  }
  return result;
}

function asArray(value, location) {
  if (!Array.isArray(value)) throw new TypeError(`${location} must be an array`);
  return value;
}

function rowCount(result) {
  if (Number.isSafeInteger(result?.rowCount)) return result.rowCount;
  return Array.isArray(result?.rows) ? result.rows.length : 0;
}

function databaseJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function exactJson(left, right) {
  return stableJson(databaseJson(left)) === stableJson(databaseJson(right));
}

function exactInstant(left, right) {
  if (left === undefined || left === null) return false;
  const parsed = new Date(left);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === right;
}

async function inTransaction(pool, work) {
  requirePool(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout TO '10s'");
    await client.query("SET LOCAL statement_timeout TO '120s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('full-managed-product-identity-evidence-loader'))",
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original ingestion failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function safeAttributeNames(attribute) {
  if (!Array.isArray(attribute?.names)) return [];
  return attribute.names
    .map((entry) => safeEvidenceText(entry?.value, 160))
    .filter(Boolean);
}

function classifyAttribute(attribute) {
  if (String(attribute?.attributeId ?? '') === MODEL_ATTRIBUTE_ID) {
    return 'MODEL';
  }
  const names = safeAttributeNames(attribute).join(' ');
  for (const classifier of ATTRIBUTE_CLASSIFIERS) {
    if (classifier.pattern.test(names)) return classifier.identifierType;
  }
  return 'CORE_ATTRIBUTE';
}

function attributeValues(attribute) {
  const candidates = [];
  const direct = safeEvidenceText(attribute?.valueText);
  if (direct) {
    candidates.push({
      language: null,
      rawValue: direct,
      representation: 'SOURCE_VALUE_TEXT',
    });
  }
  if (Array.isArray(attribute?.values)) {
    for (const value of attribute.values) {
      const rawValue = safeEvidenceText(value?.value);
      if (!rawValue) continue;
      candidates.push({
        language: safeEvidenceText(value?.language, 32),
        rawValue,
        representation: 'LOCALIZED_VALUE',
      });
    }
  }
  if (candidates.length === 0) {
    const valueId = safeEvidenceText(attribute?.valueId, 256);
    if (valueId) {
      candidates.push({
        language: null,
        rawValue: valueId,
        representation: 'VALUE_ID_FALLBACK',
      });
    }
  }

  const distinct = new Map();
  for (const candidate of candidates) {
    const key = stableJson(candidate);
    distinct.set(key, candidate);
  }
  return [...distinct.values()].sort((left, right) => (
    stableJson(left).localeCompare(stableJson(right))
  ));
}

function safeImageReference(image, inheritedGroupCode = null) {
  const reference = {
    groupCode: safeEvidenceText(image?.groupCode ?? inheritedGroupCode, 256),
    imageItemId: safeEvidenceText(image?.imageItemId, 256),
    typeCode: safeEvidenceText(image?.typeCode, 256),
  };
  if (!reference.groupCode && !reference.imageItemId && !reference.typeCode) return null;
  return reference;
}

function imageReferences(spuInfo, skc, sku) {
  const references = [];
  const addImages = (layer, images, inheritedGroupCode = null) => {
    for (const image of Array.isArray(images) ? images : []) {
      const reference = safeImageReference(image, inheritedGroupCode);
      if (!reference) continue;
      references.push({ layer, ...reference });
    }
  };

  addImages('PRODUCT', spuInfo.images);
  addImages('SKC', skc.images);
  addImages('SKU', sku.images);
  for (const group of Array.isArray(skc.siteDetailImageGroups)
    ? skc.siteDetailImageGroups
    : []) {
    const inheritedGroupCode = safeEvidenceText(group?.groupCode, 256);
    addImages('SKC_SITE_DETAIL', group?.images, inheritedGroupCode);
  }

  const distinct = new Map();
  for (const reference of references) {
    distinct.set(stableJson(reference), reference);
  }
  return [...distinct.values()].sort((left, right) => (
    stableJson(left).localeCompare(stableJson(right))
  ));
}

function packageDimensionValue(packageDimensions) {
  const dimensions = {
    lengthCm: safeEvidenceText(packageDimensions?.lengthCm, 128),
    widthCm: safeEvidenceText(packageDimensions?.widthCm, 128),
    heightCm: safeEvidenceText(packageDimensions?.heightCm, 128),
    weightG: safeEvidenceText(packageDimensions?.weightG, 128),
  };
  const populated = Object.entries(dimensions).filter(([, value]) => value !== null);
  if (populated.length === 0) return null;
  return {
    rawValue: populated
      .map(([name, value]) => `${name}=${value}`)
      .join(';'),
    evidence: {
      units: {
        lengthCm: 'cm',
        widthCm: 'cm',
        heightCm: 'cm',
        weightG: 'g',
      },
      populatedFields: populated.map(([name]) => name),
    },
  };
}

function makeSetKey({ storeCode, runId, spuName, skuCode }) {
  return payloadFingerprint({
    endpointCode: ENDPOINT_CODE,
    runId,
    skuCode,
    spuName,
    storeCode,
  });
}

function buildObservationMembers({
  setKey,
  sourceFetchedAt,
  spuInfo,
  skc,
  sku,
}) {
  const productScopeKey = `SPU:${spuInfo.spuName}`;
  const variantScopeKey = `SKU:${sku.skuCode}`;
  const members = new Map();

  const add = ({
    identifierType,
    rawValue,
    identityScope,
    scopeKey,
    sourceField,
    sourceValueKey,
    evidence = {},
  }) => {
    const sourceRawValue = safeEvidenceText(rawValue, 2_000);
    if (!sourceRawValue) return;
    if (
      typeof sourceValueKey !== 'string'
      || sourceValueKey.length === 0
      || sourceValueKey.length > 512
      || FORBIDDEN_PERSISTED_TEXT.test(sourceValueKey)
    ) {
      throw new TypeError('sourceValueKey must be safe source metadata');
    }
    const normalizedValue = identifierType === 'IMAGE_REFERENCE'
      ? null
      : normalizeIdentifierValue(identifierType, sourceRawValue);
    const member = {
      observationKey: payloadFingerprint({ setKey, sourceValueKey }),
      identifierType,
      rawValue: sourceRawValue,
      normalizedValue,
      sourceSystem: SOURCE_SYSTEM,
      sourceField,
      identityScope,
      scopeKey,
      sourceValueKey,
      evidence,
      observedAt: sourceFetchedAt,
    };
    member.payloadFingerprint = payloadFingerprint(member);
    const previous = members.get(sourceValueKey);
    if (previous && previous.payloadFingerprint !== member.payloadFingerprint) {
      throw new Error(`Duplicate sourceValueKey ${sourceValueKey} has drifted evidence`);
    }
    members.set(sourceValueKey, member);
  };

  add({
    identifierType: 'PLATFORM_SPU',
    rawValue: spuInfo.spuName,
    identityScope: 'PRODUCT',
    scopeKey: productScopeKey,
    sourceField: 'info.spuName',
    sourceValueKey: 'product.platform_spu',
  });
  add({
    identifierType: 'PLATFORM_SKC',
    rawValue: skc.skcName,
    identityScope: 'VARIANT',
    scopeKey: variantScopeKey,
    sourceField: 'info.skcInfoList.skcName',
    sourceValueKey: 'variant.platform_skc',
  });
  add({
    identifierType: 'PLATFORM_SKU',
    rawValue: sku.skuCode,
    identityScope: 'VARIANT',
    scopeKey: variantScopeKey,
    sourceField: 'info.skcInfoList.skuInfoList.skuCode',
    sourceValueKey: 'variant.platform_sku',
  });
  add({
    identifierType: 'SUPPLIER_CODE',
    rawValue: spuInfo.supplierCode,
    identityScope: 'PRODUCT',
    scopeKey: productScopeKey,
    sourceField: 'info.supplierCode',
    sourceValueKey: 'product.supplier_code',
    evidence: { sourceLayer: 'SPU', strongEvidence: false },
  });
  add({
    identifierType: 'SUPPLIER_CODE',
    rawValue: skc.supplierCode,
    identityScope: 'VARIANT',
    scopeKey: variantScopeKey,
    sourceField: 'info.skcInfoList.supplierCode',
    sourceValueKey: 'variant.skc_supplier_code',
    evidence: { sourceLayer: 'SKC', strongEvidence: false },
  });
  add({
    identifierType: 'SUPPLIER_SKU',
    rawValue: sku.supplierSku,
    identityScope: 'VARIANT',
    scopeKey: variantScopeKey,
    sourceField: 'info.skcInfoList.skuInfoList.supplierSku',
    sourceValueKey: 'variant.supplier_sku',
    evidence: { sourceLayer: 'SKU', strongEvidence: false },
  });
  add({
    identifierType: 'BRAND',
    rawValue: spuInfo.brandCode,
    identityScope: 'PRODUCT',
    scopeKey: productScopeKey,
    sourceField: 'info.brandCode',
    sourceValueKey: 'product.brand_code',
    evidence: { strongEvidence: false },
  });
  add({
    identifierType: 'CATEGORY',
    rawValue: spuInfo.categoryId,
    identityScope: 'PRODUCT',
    scopeKey: productScopeKey,
    sourceField: 'info.categoryId',
    sourceValueKey: 'product.category_id',
    evidence: { strongEvidence: false },
  });
  add({
    identifierType: 'PRODUCT_TYPE',
    rawValue: spuInfo.productTypeId,
    identityScope: 'PRODUCT',
    scopeKey: productScopeKey,
    sourceField: 'info.productTypeId',
    sourceValueKey: 'product.product_type_id',
    evidence: { strongEvidence: false },
  });

  for (const attribute of Array.isArray(spuInfo.productAttributes)
    ? spuInfo.productAttributes
    : []) {
    const identifierType = classifyAttribute(attribute);
    const attributeId = safeEvidenceText(attribute?.attributeId, 256);
    const valueId = safeEvidenceText(attribute?.valueId, 256);
    const attributeKey = attributeId ?? payloadFingerprint({
      names: safeAttributeNames(attribute),
    }).slice(0, 24);
    for (const value of attributeValues(attribute)) {
      const valueKey = payloadFingerprint({
        language: value.language,
        rawValue: value.rawValue,
        valueId,
      }).slice(0, 24);
      add({
        identifierType,
        rawValue: value.rawValue,
        identityScope: 'PRODUCT',
        scopeKey: productScopeKey,
        sourceField: `info.productAttributeInfoList.attributeId=${attributeKey}`,
        sourceValueKey: `product.attribute:${attributeKey}:${valueKey}`,
        evidence: {
          attributeId,
          valueId,
          language: value.language,
          representation: value.representation,
          classification: identifierType,
          strongEvidence: identifierType === 'MODEL',
        },
      });
    }
  }

  const dimensions = packageDimensionValue(sku.packageDimensions);
  if (dimensions) {
    add({
      identifierType: 'DIMENSIONS',
      rawValue: dimensions.rawValue,
      identityScope: 'VARIANT',
      scopeKey: variantScopeKey,
      sourceField: 'info.skcInfoList.skuInfoList.packageDimensions',
      sourceValueKey: 'variant.package_dimensions',
      evidence: { ...dimensions.evidence, strongEvidence: false },
    });
  }

  for (const barcode of Array.isArray(sku.barcodes) ? sku.barcodes : []) {
    const rawValue = safeEvidenceText(barcode?.value, 512);
    if (!rawValue) continue;
    const barcodeType = safeEvidenceText(barcode?.type, 128);
    const barcodeStandard = safeEvidenceText(barcode?.standard, 32);
    const valueKey = payloadFingerprint({
      barcodeStandard,
      barcodeType,
      rawValue,
    }).slice(0, 24);
    add({
      identifierType: 'BARCODE',
      rawValue,
      identityScope: 'VARIANT',
      scopeKey: variantScopeKey,
      sourceField: 'info.skcInfoList.skuInfoList.skuSupplierInfo.supplierBarcodeList',
      sourceValueKey: `variant.barcode:${valueKey}`,
      evidence: {
        barcodeType,
        barcodeStandard,
        gtinCheckDigitValid: isValidGtin(rawValue),
        strongEvidence: (
          (barcodeStandard === 'EAN' || barcodeStandard === 'UPC')
          && isValidGtin(rawValue)
        ),
      },
    });
  }

  for (const reference of imageReferences(spuInfo, skc, sku)) {
    const rawValue = stableJson({
      groupCode: reference.groupCode,
      imageItemId: reference.imageItemId,
      typeCode: reference.typeCode,
    });
    const referenceKey = payloadFingerprint(reference).slice(0, 24);
    add({
      identifierType: 'IMAGE_REFERENCE',
      rawValue,
      identityScope: reference.layer === 'PRODUCT' ? 'PRODUCT' : 'VARIANT',
      scopeKey: reference.layer === 'PRODUCT' ? productScopeKey : variantScopeKey,
      sourceField: `info.${reference.layer.toLowerCase()}.imageReference`,
      sourceValueKey: `auxiliary.image_reference:${referenceKey}`,
      evidence: {
        sourceLayer: reference.layer,
        strongEvidence: false,
        urlPersisted: false,
        contentFingerprint: false,
      },
    });
  }

  return [...members.values()].sort((left, right) => (
    left.sourceValueKey.localeCompare(right.sourceValueKey)
  ));
}

function validateMappedSpuInfo(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('spuInfo must be the mapped goods/spu-info response');
  }
  const spuName = requireSourceIdentifier(value.spuName, 'spuInfo.spuName');
  const responseFingerprint = requireFingerprint(
    value.responseFingerprint,
    'spuInfo.responseFingerprint',
  );
  const skcs = asArray(value.skcs, 'spuInfo.skcs');
  const mapped = [];
  const skuCodes = new Set();
  for (let skcIndex = 0; skcIndex < skcs.length; skcIndex += 1) {
    const skc = skcs[skcIndex];
    const skcName = requireSourceIdentifier(
      skc?.skcName,
      `spuInfo.skcs[${skcIndex}].skcName`,
    );
    for (const [skuIndex, sku] of asArray(
      skc?.skus,
      `spuInfo.skcs[${skcIndex}].skus`,
    ).entries()) {
      const skuCode = requireSourceIdentifier(
        sku?.skuCode,
        `spuInfo.skcs[${skcIndex}].skus[${skuIndex}].skuCode`,
      );
      if (skuCodes.has(skuCode)) {
        throw new TypeError(`spuInfo contains duplicate SKU ${skuCode}`);
      }
      skuCodes.add(skuCode);
      mapped.push({
        skc: { ...skc, skcName },
        sku: { ...sku, skuCode },
      });
    }
  }
  mapped.sort((left, right) => left.sku.skuCode.localeCompare(right.sku.skuCode));
  return {
    spuInfo: { ...value, spuName },
    spuName,
    responseFingerprint,
    skcCount: skcs.length,
    mapped,
  };
}

async function requireStore(client, storeCode) {
  const result = await client.query(
    `SELECT store_id
       FROM dim.store
      WHERE store_code = $1
        AND cooperation_mode = 'FULL_MANAGED'
        AND is_active = true`,
    [storeCode],
  );
  if (rowCount(result) !== 1) {
    throw new Error(`Active full-managed store ${storeCode} was not found`);
  }
  return result.rows[0].store_id;
}

async function resolveStoreSkus(client, storeId, spuName, mapped) {
  if (mapped.length === 0) {
    return { resolved: new Map(), unresolvedSkuCodes: [] };
  }
  const skuCodes = mapped.map(({ sku }) => sku.skuCode);
  const expectedBySkuCode = new Map(
    mapped.map((entry) => [entry.sku.skuCode, entry]),
  );
  const result = await client.query(
    `SELECT
         full_sku_id,
         platform_sku_id,
         platform_skc_id,
         platform_spu_id
       FROM dim.full_sku
      WHERE store_id = $1
        AND platform_sku_id = ANY($2::text[])`,
    [storeId, skuCodes],
  );
  const resolved = new Map();
  for (const row of result.rows ?? []) {
    const skuCode = String(row.platform_sku_id);
    const expected = expectedBySkuCode.get(skuCode);
    if (!expected || resolved.has(skuCode)) {
      throw new Error('SKU membership readback was inconsistent');
    }
    if (
      String(row.platform_sku_id) !== expected.sku.skuCode
      || String(row.platform_skc_id) !== expected.skc.skcName
      || String(row.platform_spu_id) !== spuName
    ) {
      throw new Error(
        'Product identity SKU hierarchy disagrees with dim.full_sku',
      );
    }
    resolved.set(skuCode, row);
  }
  return {
    resolved,
    unresolvedSkuCodes: skuCodes.filter((skuCode) => !resolved.has(skuCode)),
  };
}

async function insertOrReadFetchBatch(client, {
  storeId,
  runId,
  sourceFetchedAt,
  documentVersion,
  mapperVersion,
  spuInfo,
  spuName,
  responseFingerprint,
  skcCount,
  mappedSkuCount,
  resolvedSkuCount,
  unresolvedSkuCodes,
}) {
  const idempotencyKey = `${runId}:${ENDPOINT_CODE}:${spuName}`;
  const requestPayload = {
    documentVersion,
    mapperVersion,
    sourceRequestFingerprint: (
      FINGERPRINT_PATTERN.test(spuInfo.requestFingerprint ?? '')
        ? spuInfo.requestFingerprint
        : null
    ),
    spuName,
  };
  const responsePayload = {
    mappedSkuCount,
    resolvedSkuCount,
    responseFingerprint,
    skcCount,
    spuName,
    unresolvedSkuCount: unresolvedSkuCodes.length,
  };
  const status = unresolvedSkuCodes.length === 0 ? 'SUCCEEDED' : 'PARTIAL';
  const requestHash = payloadFingerprint(requestPayload);
  const values = [
    storeId,
    idempotencyKey,
    requestHash,
    status,
    mappedSkuCount,
    stableJson(requestPayload),
    stableJson(responsePayload),
    sourceFetchedAt,
  ];
  const inserted = await client.query(
    `INSERT INTO raw.openapi_fetch_batch (
         store_id, capability_code, endpoint_code, idempotency_key,
         request_fingerprint, status, http_status, response_record_count,
         request_payload, response_payload, started_at, completed_at
     ) VALUES (
         $1, '${CAPABILITY_CODE}', '${ENDPOINT_CODE}', $2,
         $3, $4, 200, $5, $6::jsonb, $7::jsonb, $8, $8
     )
     ON CONFLICT (store_id, idempotency_key) DO NOTHING
     RETURNING fetch_batch_id`,
    values,
  );
  if (rowCount(inserted) === 1) {
    return { fetchBatchId: inserted.rows[0].fetch_batch_id, created: true };
  }

  const existing = await client.query(
    `SELECT
         fetch_batch_id,
         capability_code,
         endpoint_code,
         request_fingerprint,
         status,
         http_status,
         response_record_count,
         request_payload,
         response_payload,
         started_at,
         completed_at
       FROM raw.openapi_fetch_batch
      WHERE store_id = $1
        AND idempotency_key = $2`,
    [storeId, idempotencyKey],
  );
  if (rowCount(existing) !== 1) {
    throw new Error('Product identity fetch batch conflict could not be read back');
  }
  const row = existing.rows[0];
  const exactReplay = (
    row.capability_code === CAPABILITY_CODE
    && row.endpoint_code === ENDPOINT_CODE
    && row.request_fingerprint === requestHash
    && row.status === status
    && Number(row.http_status) === 200
    && Number(row.response_record_count) === mappedSkuCount
    && exactJson(row.request_payload, requestPayload)
    && exactJson(row.response_payload, responsePayload)
    && exactInstant(row.started_at, sourceFetchedAt)
    && exactInstant(row.completed_at, sourceFetchedAt)
  );
  if (!exactReplay) {
    throw new Error(
      'Product identity fetch batch idempotency key was reused with drifted evidence',
    );
  }
  return { fetchBatchId: row.fetch_batch_id, created: false };
}

function expectedSet({
  storeCode,
  runId,
  sourceFetchedAt,
  documentVersion,
  mapperVersion,
  responseFingerprint,
  spuInfo,
  skc,
  sku,
}) {
  const setKey = makeSetKey({
    storeCode,
    runId,
    spuName: spuInfo.spuName,
    skuCode: sku.skuCode,
  });
  const members = buildObservationMembers({
    setKey,
    sourceFetchedAt,
    spuInfo,
    skc,
    sku,
  });
  const setPayloadFingerprint = payloadFingerprint({
    documentVersion,
    mapperVersion,
    platformSkcId: skc.skcName,
    platformSkuId: sku.skuCode,
    platformSpuId: spuInfo.spuName,
    responseFingerprint,
    sourceFetchedAt,
    members: members.map((member) => ({
      observationKey: member.observationKey,
      payloadFingerprint: member.payloadFingerprint,
      sourceValueKey: member.sourceValueKey,
    })),
  });
  return {
    setKey,
    members,
    setPayloadFingerprint,
  };
}

async function readSetMembers(client, identityObservationSetId) {
  const result = await client.query(
    `SELECT observation_key, source_value_key, payload_fingerprint
       FROM raw.identifier_observation
      WHERE identity_observation_set_id = $1
      ORDER BY source_value_key`,
    [identityObservationSetId],
  );
  return result.rows ?? [];
}

function assertMemberReadback(expectedMembers, actualMembers) {
  if (expectedMembers.length !== actualMembers.length) {
    throw new Error('Product identity observation member count drifted on readback');
  }
  for (let index = 0; index < expectedMembers.length; index += 1) {
    const expected = expectedMembers[index];
    const actual = actualMembers[index];
    if (
      actual.observation_key !== expected.observationKey
      || actual.source_value_key !== expected.sourceValueKey
      || actual.payload_fingerprint !== expected.payloadFingerprint
    ) {
      throw new Error('Product identity observation member fingerprint drifted on readback');
    }
  }
}

async function insertMembers(client, {
  identityObservationSetId,
  storeId,
  fullSkuId,
  fetchBatchId,
  members,
}) {
  for (const member of members) {
    await client.query(
      `INSERT INTO raw.identifier_observation (
           store_id,
           full_sku_id,
           observation_key,
           identifier_type,
           raw_value,
           normalized_value,
           source_system,
           source_field,
           source_fetch_batch_id,
           payload_fingerprint,
           evidence,
           observed_at,
           identity_observation_set_id,
           identity_scope,
           scope_key,
           source_value_key
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11::jsonb, $12, $13, $14, $15, $16
       )`,
      [
        storeId,
        fullSkuId,
        member.observationKey,
        member.identifierType,
        member.rawValue,
        member.normalizedValue,
        member.sourceSystem,
        member.sourceField,
        fetchBatchId,
        member.payloadFingerprint,
        stableJson(member.evidence),
        member.observedAt,
        identityObservationSetId,
        member.identityScope,
        member.scopeKey,
        member.sourceValueKey,
      ],
    );
  }
}

async function insertOrReadObservationSet(client, {
  storeId,
  fullSku,
  fetchBatchId,
  runId,
  sourceFetchedAt,
  documentVersion,
  mapperVersion,
  responseFingerprint,
  spuInfo,
  skc,
  sku,
  expected,
}) {
  const values = [
    storeId,
    fullSku.full_sku_id,
    fetchBatchId,
    runId,
    expected.setKey,
    spuInfo.spuName,
    skc.skcName,
    sku.skuCode,
    documentVersion,
    mapperVersion,
    responseFingerprint,
    expected.setPayloadFingerprint,
    sourceFetchedAt,
  ];
  const inserted = await client.query(
    `INSERT INTO raw.product_identity_observation_set (
         store_id,
         full_sku_id,
         source_fetch_batch_id,
         observation_run_id,
         observation_set_key,
         platform_spu_id,
         platform_skc_id,
         platform_sku_id,
         document_version,
         mapper_version,
         status,
         member_count,
         source_response_fingerprint,
         set_payload_fingerprint,
         source_fetched_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         'BUILDING', 0, $11, $12, $13
     )
     ON CONFLICT (store_id, observation_run_id, full_sku_id) DO NOTHING
     RETURNING identity_observation_set_id`,
    values,
  );

  let identityObservationSetId;
  let created = false;
  if (rowCount(inserted) === 1) {
    identityObservationSetId = inserted.rows[0].identity_observation_set_id;
    await insertMembers(client, {
      identityObservationSetId,
      storeId,
      fullSkuId: fullSku.full_sku_id,
      fetchBatchId,
      members: expected.members,
    });
    const sealed = await client.query(
      `UPDATE raw.product_identity_observation_set
          SET status = 'SEALED',
              member_count = $2,
              sealed_at = GREATEST(clock_timestamp(), $3::timestamptz)
        WHERE identity_observation_set_id = $1
          AND status = 'BUILDING'
      RETURNING identity_observation_set_id`,
      [identityObservationSetId, expected.members.length, sourceFetchedAt],
    );
    if (rowCount(sealed) !== 1) {
      throw new Error('Product identity observation set could not be sealed');
    }
    created = true;
  } else {
    const existing = await client.query(
      `SELECT
           identity_observation_set_id,
           full_sku_id,
           source_fetch_batch_id,
           observation_run_id,
           observation_set_key,
           platform_spu_id,
           platform_skc_id,
           platform_sku_id,
           document_version,
           mapper_version,
           status,
           member_count,
           source_response_fingerprint,
           set_payload_fingerprint,
           source_fetched_at
         FROM raw.product_identity_observation_set
         WHERE store_id = $1
           AND observation_run_id = $2
           AND full_sku_id = $3`,
      [storeId, runId, fullSku.full_sku_id],
    );
    if (rowCount(existing) !== 1) {
      throw new Error('Product identity observation set conflict could not be read back');
    }
    const row = existing.rows[0];
    const exactReplay = (
      String(row.full_sku_id) === String(fullSku.full_sku_id)
      && String(row.source_fetch_batch_id) === String(fetchBatchId)
      && row.observation_run_id === runId
      && row.observation_set_key === expected.setKey
      && row.platform_spu_id === spuInfo.spuName
      && row.platform_skc_id === skc.skcName
      && row.platform_sku_id === sku.skuCode
      && Number(row.document_version) === documentVersion
      && row.mapper_version === mapperVersion
      && row.status === 'SEALED'
      && Number(row.member_count) === expected.members.length
      && row.source_response_fingerprint === responseFingerprint
      && row.set_payload_fingerprint === expected.setPayloadFingerprint
      && exactInstant(row.source_fetched_at, sourceFetchedAt)
    );
    if (!exactReplay) {
      throw new Error('Product identity observation set key was reused with drifted evidence');
    }
    identityObservationSetId = row.identity_observation_set_id;
  }

  const actualMembers = await readSetMembers(client, identityObservationSetId);
  assertMemberReadback(expected.members, actualMembers);
  return {
    identityObservationSetId,
    created,
    memberCount: expected.members.length,
  };
}

/**
 * Persist one already-mapped official goods/spu-info response as append-only
 * identity evidence. This repository never performs a network request.
 */
export async function recordProductIdentitySpuObservation(pool, {
  storeCode,
  runId,
  sourceFetchedAt,
  documentVersion = 27,
  mapperVersion = 'spu-info-v1',
  spuInfo,
} = {}) {
  const code = requireStoreCode(storeCode);
  const safeRunId = requireRunId(runId);
  const observedAt = requireInstant(sourceFetchedAt, 'sourceFetchedAt');
  const docVersion = requireDocumentVersion(documentVersion);
  const safeMapperVersion = requireMapperVersion(mapperVersion);
  const mappedInfo = validateMappedSpuInfo(spuInfo);

  return inTransaction(pool, async (client) => {
    const storeId = await requireStore(client, code);
    const membership = await resolveStoreSkus(
      client,
      storeId,
      mappedInfo.spuName,
      mappedInfo.mapped,
    );
    const batch = await insertOrReadFetchBatch(client, {
      storeId,
      runId: safeRunId,
      sourceFetchedAt: observedAt,
      documentVersion: docVersion,
      mapperVersion: safeMapperVersion,
      spuInfo: mappedInfo.spuInfo,
      spuName: mappedInfo.spuName,
      responseFingerprint: mappedInfo.responseFingerprint,
      skcCount: mappedInfo.skcCount,
      mappedSkuCount: mappedInfo.mapped.length,
      resolvedSkuCount: membership.resolved.size,
      unresolvedSkuCodes: membership.unresolvedSkuCodes,
    });

    let createdSetCount = 0;
    let replayedSetCount = 0;
    let memberCount = 0;
    for (const { skc, sku } of mappedInfo.mapped) {
      const fullSku = membership.resolved.get(sku.skuCode);
      if (!fullSku) continue;
      const expected = expectedSet({
        storeCode: code,
        runId: safeRunId,
        sourceFetchedAt: observedAt,
        documentVersion: docVersion,
        mapperVersion: safeMapperVersion,
        responseFingerprint: mappedInfo.responseFingerprint,
        spuInfo: mappedInfo.spuInfo,
        skc,
        sku,
      });
      const setResult = await insertOrReadObservationSet(client, {
        storeId,
        fullSku,
        fetchBatchId: batch.fetchBatchId,
        runId: safeRunId,
        sourceFetchedAt: observedAt,
        documentVersion: docVersion,
        mapperVersion: safeMapperVersion,
        responseFingerprint: mappedInfo.responseFingerprint,
        spuInfo: mappedInfo.spuInfo,
        skc,
        sku,
        expected,
      });
      createdSetCount += setResult.created ? 1 : 0;
      replayedSetCount += setResult.created ? 0 : 1;
      memberCount += setResult.memberCount;
    }

    return Object.freeze({
      storeCode: code,
      spuName: mappedInfo.spuName,
      fetchBatchId: batch.fetchBatchId,
      fetchBatchCreated: batch.created,
      mappedSkuCount: mappedInfo.mapped.length,
      observedSkuCount: mappedInfo.mapped.length,
      persistedSkuCount: membership.resolved.size,
      resolvedSkuCount: membership.resolved.size,
      unresolvedSkuCount: membership.unresolvedSkuCodes.length,
      unresolvedSkuCodes: Object.freeze([...membership.unresolvedSkuCodes]),
      observationSetCount: membership.resolved.size,
      createdSetCount,
      createdObservationSetCount: createdSetCount,
      replayedSetCount,
      memberCount,
      responseFingerprint: mappedInfo.responseFingerprint,
    });
  });
}
