import assert from 'node:assert/strict';
import test from 'node:test';

import { payloadFingerprint } from '../../src/openapi/paginated-fetch.mjs';
import {
  recordProductIdentitySpuObservation,
} from '../../src/warehouse/product-identity-evidence-repository.mjs';

const SOURCE_FETCHED_AT = '2026-07-27T02:03:04.000Z';

function mappedSpuInfo(overrides = {}) {
  const facts = {
    spuName: 'SPU-100',
    supplierCode: 'SUP-PRODUCT-100',
    brandCode: 'BRAND-9',
    categoryId: '1980',
    productTypeId: '71',
    names: [{ language: 'zh-cn', value: '不会落库的商品名' }],
    reportedProductAttributes: [],
    productAttributes: [{
      attributeId: '1000546',
      names: [{ language: 'zh-cn', value: '型号' }],
      valueId: 'MODEL-VALUE-1',
      valueText: null,
      values: [{ language: 'zh-cn', value: 'MODEL-X100' }],
    }, {
      attributeId: '9002',
      names: [{ language: 'zh-cn', value: '额定电压' }],
      valueId: 'V220',
      valueText: '220 ～ 240 伏',
      values: [],
    }, {
      attributeId: '9003',
      names: [{ language: 'zh-cn', value: '材质' }],
      valueId: 'STEEL',
      valueText: '不锈钢',
      values: [],
    }],
    dimensionAttributes: [],
    images: [{
      groupCode: 'SPU-GROUP',
      imageItemId: 'IMG-SPU-1',
      typeCode: 'MAIN',
      imageUrl: 'https://img.example/spu.jpg?access_token=DO_NOT_STORE',
    }],
    skcs: [{
      skcName: 'SKC-100-BLACK',
      supplierCode: 'SUP-SKC-100-BLACK',
      names: [],
      saleAttribute: null,
      images: [{
        groupCode: 'SKC-GROUP',
        imageItemId: 'IMG-SKC-1',
        typeCode: 'MAIN',
        imageUrl: 'https://img.example/skc.jpg?signature=DO_NOT_STORE',
      }],
      siteDetailImageGroups: [{
        groupCode: 'DETAIL-GROUP',
        images: [{
          groupCode: null,
          imageItemId: 'IMG-DETAIL-1',
          typeCode: 'DETAIL',
          imageUrl: 'https://img.example/detail.jpg?token=DO_NOT_STORE',
        }],
        sites: [],
      }],
      skus: [{
        skuCode: 'SKU-100-A',
        supplierSku: 'SELLER-SKU-A',
        saleAttributes: [],
        packageDimensions: {
          lengthCm: '11.00',
          widthCm: '12.00',
          heightCm: '13.00',
          weightG: '222',
        },
        barcodes: [{
          type: 'EAN',
          standard: 'EAN',
          value: '6901234567892',
        }, {
          type: 'UPC',
          standard: 'UPC',
          value: '012345678905',
        }, {
          type: 'FUTURE',
          standard: null,
          value: 'RAW-123',
        }],
        images: [{
          groupCode: 'SKU-GROUP',
          imageItemId: 'IMG-SKU-1',
          typeCode: 'MAIN',
          imageUrl: 'https://img.example/sku.jpg?cookie=DO_NOT_STORE',
        }],
      }],
    }],
    traceId: 'Bearer DO_NOT_STORE',
    ...overrides,
  };
  return {
    ...facts,
    requestFingerprint: 'a'.repeat(64),
    responseFingerprint: overrides.responseFingerprint
      ?? payloadFingerprint(facts),
  };
}

class FakeIdentityDatabase {
  constructor({
    resolvedSkuCodes = ['SKU-100-A'],
    hierarchyOverrides = {},
  } = {}) {
    this.calls = [];
    this.released = false;
    this.resolvedSkuCodes = new Set(resolvedSkuCodes);
    this.hierarchyOverrides = hierarchyOverrides;
    this.batches = new Map();
    this.sets = new Map();
    this.members = new Map();
    this.nextBatchId = 40;
    this.nextSetId = 80;
  }

  result(rows = []) {
    return { rows, rowCount: rows.length };
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    if (sql.includes('FROM dim.store')) {
      return this.result([{ store_id: 1 }]);
    }
    if (sql.includes('FROM dim.full_sku')) {
      const requested = values[1];
      return this.result(
        requested
          .filter((skuCode) => this.resolvedSkuCodes.has(skuCode))
          .map((skuCode, index) => ({
            full_sku_id: 10 + index,
            platform_sku_id: skuCode,
            platform_skc_id: 'SKC-100-BLACK',
            platform_spu_id: 'SPU-100',
            ...(this.hierarchyOverrides[skuCode] ?? {}),
          })),
      );
    }
    if (sql.includes('INSERT INTO raw.openapi_fetch_batch')) {
      const key = `${values[0]}:${values[1]}`;
      if (this.batches.has(key)) return this.result();
      const row = {
        fetch_batch_id: this.nextBatchId++,
        capability_code: 'FULL_MANAGED_PRODUCT_IDENTITY',
        endpoint_code: 'goods.spu-info',
        request_fingerprint: values[2],
        status: values[3],
        http_status: 200,
        response_record_count: values[4],
        request_payload: JSON.parse(values[5]),
        response_payload: JSON.parse(values[6]),
        started_at: values[7],
        completed_at: values[7],
      };
      this.batches.set(key, row);
      return this.result([{ fetch_batch_id: row.fetch_batch_id }]);
    }
    if (sql.includes('FROM raw.openapi_fetch_batch')) {
      return this.result([this.batches.get(`${values[0]}:${values[1]}`)]);
    }
    if (sql.includes('INSERT INTO raw.product_identity_observation_set')) {
      const key = `${values[0]}:${values[3]}`;
      if (this.sets.has(key)) return this.result();
      const row = {
        identity_observation_set_id: this.nextSetId++,
        full_sku_id: values[1],
        source_fetch_batch_id: values[2],
        platform_spu_id: values[4],
        platform_skc_id: values[5],
        platform_sku_id: values[6],
        document_version: values[7],
        mapper_version: values[8],
        status: 'BUILDING',
        member_count: 0,
        source_response_fingerprint: values[9],
        set_payload_fingerprint: values[10],
        source_fetched_at: values[11],
      };
      this.sets.set(key, row);
      this.members.set(row.identity_observation_set_id, []);
      return this.result([{
        identity_observation_set_id: row.identity_observation_set_id,
      }]);
    }
    if (sql.includes('INSERT INTO raw.identifier_observation')) {
      const member = {
        observation_key: values[2],
        source_value_key: values[15],
        payload_fingerprint: values[9],
        values,
      };
      this.members.get(values[12]).push(member);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE raw.product_identity_observation_set')) {
      const set = [...this.sets.values()].find(
        (candidate) => candidate.identity_observation_set_id === values[0],
      );
      set.status = 'SEALED';
      set.member_count = values[1];
      set.sealed_at = values[2];
      return this.result([{
        identity_observation_set_id: set.identity_observation_set_id,
      }]);
    }
    if (
      sql.includes('FROM raw.product_identity_observation_set')
      && sql.includes('observation_set_key')
    ) {
      return this.result([this.sets.get(`${values[0]}:${values[1]}`)]);
    }
    if (sql.includes('FROM raw.identifier_observation')) {
      const members = this.members.get(values[0]) ?? [];
      return this.result(
        [...members].sort((left, right) => (
          left.source_value_key.localeCompare(right.source_value_key)
        )),
      );
    }
    return { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

function pool(database) {
  return {
    async connect() {
      return database;
    },
  };
}

function options(spuInfo = mappedSpuInfo()) {
  return {
    storeCode: 'DL',
    runId: 'identity-20260727:DL:SPU-100',
    sourceFetchedAt: SOURCE_FETCHED_AT,
    documentVersion: 27,
    mapperVersion: 'spu-info-v1',
    spuInfo,
  };
}

function normalizedQueries(database) {
  return database.calls.map(({ sql }) => sql.replace(/\s+/g, ' ').trim());
}

test('records one sealed observation set with layered attributes, barcodes and URL-free images', async () => {
  const database = new FakeIdentityDatabase();
  const result = await recordProductIdentitySpuObservation(
    pool(database),
    options(),
  );

  assert.equal(result.storeCode, 'DL');
  assert.equal(result.spuName, 'SPU-100');
  assert.equal(result.mappedSkuCount, 1);
  assert.equal(result.observedSkuCount, 1);
  assert.equal(result.resolvedSkuCount, 1);
  assert.equal(result.unresolvedSkuCount, 0);
  assert.equal(result.createdSetCount, 1);
  assert.equal(result.replayedSetCount, 0);
  assert.equal(result.memberCount, 20);
  assert.equal(database.released, true);
  assert.equal(normalizedQueries(database)[0], 'BEGIN');
  assert.match(
    normalizedQueries(database)[3],
    /pg_advisory_xact_lock\(hashtext\('full-managed-product-identity-evidence-loader'\)\)/,
  );
  assert.equal(
    normalizedQueries(database).some(
      (query) => query.includes('full-managed-sales-loader'),
    ),
    false,
  );
  assert.equal(normalizedQueries(database).at(-1), 'COMMIT');

  const memberCalls = database.calls.filter(
    ({ sql }) => sql.includes('INSERT INTO raw.identifier_observation'),
  );
  const types = memberCalls.map(({ values }) => values[3]);
  assert.equal(types.filter((type) => type === 'BARCODE').length, 3);
  assert.equal(types.includes('MODEL'), true);
  assert.equal(types.includes('VOLTAGE'), true);
  assert.equal(types.includes('CORE_ATTRIBUTE'), true);
  assert.equal(types.includes('DIMENSIONS'), true);
  assert.equal(types.filter((type) => type === 'IMAGE_REFERENCE').length, 4);
  for (const { values } of memberCalls.filter(({ values }) => values[3] === 'BARCODE')) {
    assert.equal(values[13], 'VARIANT');
  }

  const persistedValues = JSON.stringify(
    database.calls.flatMap(({ values }) => values),
  );
  assert.doesNotMatch(
    persistedValues,
    /https?:\/\/|DO_NOT_STORE|Bearer|access_token|signature|cookie/i,
  );
  assert.equal(
    database.calls.every(({ sql }) => !sql.includes('SPU-100')),
    true,
    'source values must be query parameters rather than SQL interpolation',
  );
});

test('hierarchy drift rolls back before any product identity evidence is written', async () => {
  const cases = [
    ['platform_spu_id', 'SPU-WRONG'],
    ['platform_skc_id', 'SKC-WRONG'],
    ['platform_sku_id', 'SKU-WRONG'],
  ];

  for (const [field, value] of cases) {
    const database = new FakeIdentityDatabase({
      hierarchyOverrides: {
        'SKU-100-A': { [field]: value },
      },
    });

    await assert.rejects(
      () => recordProductIdentitySpuObservation(pool(database), options()),
      /SKU hierarchy disagrees with dim\.full_sku|SKU membership readback was inconsistent/,
    );
    assert.equal(
      normalizedQueries(database).at(-1),
      'ROLLBACK',
      `${field} drift must roll back`,
    );
    assert.equal(
      database.calls.some(
        ({ sql }) => (
          sql.includes('INSERT INTO raw.openapi_fetch_batch')
          || sql.includes('INSERT INTO raw.product_identity_observation_set')
          || sql.includes('INSERT INTO raw.identifier_observation')
        ),
      ),
      false,
      `${field} drift must fail before evidence writes`,
    );
  }
});

test('exact replay reads back batch, sealed set and every member fingerprint', async () => {
  const database = new FakeIdentityDatabase();
  const first = await recordProductIdentitySpuObservation(
    pool(database),
    options(),
  );
  const second = await recordProductIdentitySpuObservation(
    pool(database),
    options(),
  );

  assert.equal(first.fetchBatchCreated, true);
  assert.equal(second.fetchBatchCreated, false);
  assert.equal(second.createdSetCount, 0);
  assert.equal(second.replayedSetCount, 1);
  assert.equal(second.memberCount, first.memberCount);
  assert.equal(
    database.calls.filter(
      ({ sql }) => sql.includes('INSERT INTO raw.identifier_observation'),
    ).length,
    first.memberCount,
  );
  assert.equal(
    database.calls.filter(
      ({ sql }) => (
        sql.includes('FROM raw.identifier_observation')
        && sql.includes('payload_fingerprint')
      ),
    ).length,
    2,
  );
});

test('same run key with drifted mapped evidence rolls back instead of appending', async () => {
  const database = new FakeIdentityDatabase();
  await recordProductIdentitySpuObservation(pool(database), options());
  const drifted = mappedSpuInfo({
    responseFingerprint: 'f'.repeat(64),
  });

  await assert.rejects(
    () => recordProductIdentitySpuObservation(
      pool(database),
      options(drifted),
    ),
    /idempotency key was reused with drifted evidence/,
  );
  assert.equal(normalizedQueries(database).at(-1), 'ROLLBACK');
  assert.equal(database.sets.size, 1);
});

test('unresolved platform SKUs are counted but never receive fabricated sets', async () => {
  const first = mappedSpuInfo();
  const secondSku = {
    ...first.skcs[0].skus[0],
    skuCode: 'SKU-100-MISSING',
    supplierSku: 'SELLER-SKU-MISSING',
  };
  const skcs = [{
    ...first.skcs[0],
    skus: [...first.skcs[0].skus, secondSku],
  }];
  const facts = { ...first, skcs };
  delete facts.requestFingerprint;
  delete facts.responseFingerprint;
  const twoSkuInfo = {
    ...facts,
    requestFingerprint: first.requestFingerprint,
    responseFingerprint: payloadFingerprint(facts),
  };
  const database = new FakeIdentityDatabase({
    resolvedSkuCodes: ['SKU-100-A'],
  });

  const result = await recordProductIdentitySpuObservation(
    pool(database),
    options(twoSkuInfo),
  );

  assert.equal(result.mappedSkuCount, 2);
  assert.equal(result.observedSkuCount, 2);
  assert.equal(result.persistedSkuCount, 1);
  assert.equal(result.unresolvedSkuCount, 1);
  assert.deepEqual(result.unresolvedSkuCodes, ['SKU-100-MISSING']);
  assert.equal(database.sets.size, 1);
  const batchInsert = database.calls.find(
    ({ sql }) => sql.includes('INSERT INTO raw.openapi_fetch_batch'),
  );
  assert.equal(batchInsert.values[3], 'PARTIAL');
  assert.equal(JSON.parse(batchInsert.values[6]).unresolvedSkuCount, 1);
});

test('invalid document versions and unsafe mapper input fail before a transaction', async () => {
  const database = new FakeIdentityDatabase();
  await assert.rejects(
    () => recordProductIdentitySpuObservation(pool(database), {
      ...options(),
      documentVersion: 26,
    }),
    /documentVersion must be the pinned official version 27/,
  );
  await assert.rejects(
    () => recordProductIdentitySpuObservation(pool(database), {
      ...options(),
      mapperVersion: 'spu info; drop table',
    }),
    /mapperVersion/,
  );
  assert.equal(database.calls.length, 0);
});
