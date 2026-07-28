import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  WEBAPI_ALLOWED_PATHS,
  WEBAPI_ENDPOINT_CODES,
  WebApiContractError,
  describeEndpoint,
  resolveEndpointUrl,
} from '../../src/webapi-experiment/endpoint-allowlist.mjs';
import { parseStrictDecimalString } from '../../src/webapi-experiment/decimal.mjs';
import {
  SEMANTIC_STATUSES,
  assertNoFormalProjection,
  buildUnmappedObservations,
  projectableToFormalFact,
} from '../../src/webapi-experiment/observation.mjs';
import {
  LAUNCH_REJECT_CODES,
  WEBAPI_PROFILE_KEYS,
  WEBAPI_STORE_CODES,
  assertRealProfileLaunchAllowed,
  resolveProfileKey,
} from '../../src/webapi-experiment/profile-guard.mjs';
import { createWebApiExperimentAdapter } from '../../src/webapi-experiment/adapter.mjs';
import { assertSecretFreeOutput } from '../../src/webapi-experiment/redaction.mjs';
import {
  schemaPathCatalog,
  validateEndpointResponse,
} from '../../src/webapi-experiment/schema.mjs';

const projectRoot = new URL('../../', import.meta.url);

const LINUX_READY = Object.freeze({
  platform: 'linux',
  gateExists: true,
  availableDependencies: ['chrome', 'xvfb'],
  profileExists: true,
});

test('only the five evidenced read-only endpoints exist', () => {
  assert.deepEqual([...WEBAPI_ENDPOINT_CODES].sort(), [
    'HOME_DATA_OVERVIEW_DETAIL',
    'HOME_DATA_OVERVIEW_LIST',
    'HOME_KEY_INDICATOR_TRENDS',
    'HOME_TEMPLATE_LIST',
    'HOME_V4_DETAIL',
  ]);
  assert.deepEqual([...WEBAPI_ALLOWED_PATHS].sort(), [
    '/sso/homePage/dataOverview/list',
    '/sso/homePage/dataOverview/v2/detail',
    '/sso/homePage/key/indicator/keyAndTrends',
    '/sso/homePage/v2/list',
    '/sso/homePage/v4/detail',
  ]);
  for (const code of WEBAPI_ENDPOINT_CODES) {
    assert.ok(['GET', 'POST'].includes(describeEndpoint(code).method));
  }
  assert.throws(() => describeEndpoint('HOME_TREND_HISTORY'), WebApiContractError);
  assert.throws(() => resolveEndpointUrl('ANY_WRITE_ROUTE'), WebApiContractError);
  assert.equal(
    resolveEndpointUrl('HOME_TEMPLATE_LIST', { templateType: 1 }),
    'https://sso.geiwohuo.com/sso/homePage/v2/list?templateType=1',
  );
});

test('strict decimal validation preserves exact bounded strings and rejects unsafe representations', () => {
  for (const text of [
    '0', '-0', '-0.00', '12', '12.34', '-5.5', '0.0000000001', '1.10',
  ]) {
    assert.equal(parseStrictDecimalString(text).ok, true, text);
    assert.equal(parseStrictDecimalString(text).text, text);
  }
  for (const value of [
    1234, 12.34, null, undefined, true, {}, [],
    '', ' ', '1.2e3', '+5', '01', '1,234', 'NaN', 'Infinity',
    '1.20000000000', '9'.repeat(40),
  ]) {
    assert.equal(parseStrictDecimalString(value).ok, false, String(value));
  }
  // A JSON number has already lost precision before validation.
  assert.equal(parseStrictDecimalString(12.34).code, 'DECIMAL_NOT_A_STRING');
});

test('metric rows become UNMAPPED observations and never a formal fact', () => {
  const projection = buildUnmappedObservations({
    endpointCode: 'HOME_DATA_OVERVIEW_DETAIL',
    storeCode: 'MZ2406',
    observedAt: '2026-07-28T02:00:00.000Z',
    rows: [
      { metaIndexId: 70, code: 'GSP000016', count: '12.34', currency: 'CNY' },
      { metaIndexId: 71, code: 'GSP000017', count: '1.2e3' },
      { metaIndexId: 72, code: 'not-a-code', count: '5' },
    ],
  });
  assert.equal(projection.observations.length, 1);
  assert.equal(projection.observations[0].semanticStatus, SEMANTIC_STATUSES.UNMAPPED);
  assert.equal(projection.observations[0].rawValueText, '12.34');
  assert.equal(typeof projection.observations[0].rawValueText, 'string');
  assert.equal(projection.illegalDecimalCount, 1);
  assert.equal(projection.unknownMetricCount, 3);
  assert.equal(projection.rejected.length, 2);
  for (const rejected of projection.rejected) {
    assert.equal(rejected.semanticStatus, SEMANTIC_STATUSES.REJECTED);
    // A rejected row keeps only a sanitized reason, never the raw payload.
    assert.ok(
      rejected.rawValueText === undefined || rejected.rawValueText === null,
      'a rejected row must not retain its raw value',
    );
    assert.match(rejected.sanitizedRejectCode, /^[A-Z][A-Z0-9_]{2,60}$/);
  }
  assert.deepEqual(projectableToFormalFact(projection.observations), []);
  assert.throws(
    () => assertNoFormalProjection([{
      metaIndexId: 70,
      metricCode: 'GSP000016',
      semanticStatus: SEMANTIC_STATUSES.VERIFIED,
    }]),
    /WEBAPI_FORMAL_PROJECTION_REFUSED|VERIFIED/,
  );
});

test('catalog and permission endpoints carry no metric value at all', () => {
  for (const endpointCode of [
    'HOME_DATA_OVERVIEW_LIST',
    'HOME_TEMPLATE_LIST',
    'HOME_KEY_INDICATOR_TRENDS',
  ]) {
    const projection = buildUnmappedObservations({
      endpointCode,
      storeCode: 'DL5477',
      observedAt: '2026-07-28T02:00:00.000Z',
      rows: [{ metaIndexId: 60, code: 'GSP000016', count: '9' }],
    });
    assert.equal(projection.carriesMetricValues, false);
    assert.equal(projection.observations.length, 0);
  }
  assert.deepEqual(
    validateEndpointResponse('HOME_TEMPLATE_LIST', { list: [{ metaIndexId: 60 }] }).rows,
    [{ metaIndexId: 60 }],
  );
  assert.throws(
    () => validateEndpointResponse('HOME_V4_DETAIL', { list: [{ metaIndexId: 0, code: 'X' }] }),
    WebApiContractError,
  );
});

test('an adapter without an injected transport makes zero requests and reports BLOCKED', async () => {
  const adapter = createWebApiExperimentAdapter({ storeCode: 'DL5477' });
  assert.equal(adapter.hasTransport, false);
  const result = await adapter.probeEndpoint('HOME_DATA_OVERVIEW_DETAIL', { metaIndexIds: [70] });
  assert.equal(result.batch.resultStatus, 'BLOCKED');
  assert.equal(result.batch.sanitizedErrorCode, 'WEBAPI_TRANSPORT_NOT_CONFIGURED');
  assert.equal(result.observations.length, 0);
  assert.equal(result.batch.experimentGate, 'EXPERIMENT_ONLY');
  await assert.rejects(() => adapter.fetchWindow(), /WEBAPI_EXPERIMENT_ONLY|experiment/);
});

test('DL5477 and MZ2406 stay isolated and canonical everywhere', async () => {
  assert.deepEqual([...WEBAPI_STORE_CODES], ['DL5477', 'MZ2406']);
  assert.equal(WEBAPI_PROFILE_KEYS.DL5477, 'persistent-dl5477-profile');
  assert.equal(WEBAPI_PROFILE_KEYS.MZ2406, 'persistent-mz2406-profile');
  for (const bare of ['DL', 'MZ', 'dl', 'mz', '', 'DL5478']) {
    assert.throws(() => resolveProfileKey(bare), /STORE_NOT_ALLOWED|allowed/);
  }

  const calls = [];
  const transport = async ({ url }) => {
    calls.push(url);
    return { httpStatus: 200, body: { list: [{ metaIndexId: 70, code: 'GSP000016', count: '1' }] } };
  };
  const batches = [];
  for (const storeCode of WEBAPI_STORE_CODES) {
    const adapter = createWebApiExperimentAdapter({ storeCode, transport });
    const result = await adapter.probeEndpoint(
      'HOME_DATA_OVERVIEW_DETAIL',
      { metaIndexIds: [70] },
    );
    batches.push(result.batch);
    for (const observation of result.observations) {
      assert.equal(observation.storeCode, storeCode);
    }
  }
  assert.equal(batches[0].storeCode, 'DL5477');
  assert.equal(batches[1].storeCode, 'MZ2406');
  assert.equal(batches[0].profileKey, 'persistent-dl5477-profile');
  assert.equal(batches[1].profileKey, 'persistent-mz2406-profile');
  // Distinct idempotency keys keep the two stores' evidence separate.
  assert.notEqual(batches[0].batchKey, batches[1].batchKey);
  assert.equal(calls.length, 2);
});

test('batch metadata and adapter output stay secret-free', async () => {
  const adapter = createWebApiExperimentAdapter({
    storeCode: 'MZ2406',
    transport: async () => ({
      httpStatus: 200,
      body: { list: [{ metaIndexId: 70, code: 'GSP000016', count: '12.34', currency: 'CNY' }] },
    }),
  });
  const result = await adapter.probeEndpoint('HOME_DATA_OVERVIEW_DETAIL', { metaIndexIds: [70] });
  assert.doesNotThrow(() => assertSecretFreeOutput(result.batch, 'test-batch'));
  const serialized = JSON.stringify(result.batch);
  for (const forbidden of ['Cookie', 'Authorization', 'token', 'password', '/srv/shein-fm']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
  assert.throws(
    () => assertSecretFreeOutput({ note: 'Cookie: abc=1' }),
    /WEBAPI_OUTPUT_REDACTION_VIOLATION|secret/,
  );
  assert.throws(
    () => assertSecretFreeOutput({ path: '/srv/shein-fm/webapi/profiles/persistent-dl5477-profile' }),
    /WEBAPI_OUTPUT_REDACTION_VIOLATION|secret/,
  );
});

test('a real Profile launch fails closed before any process could be created', () => {
  // Windows, macOS or any non-Linux host is refused outright.
  for (const platform of ['win32', 'darwin', '', undefined]) {
    assert.throws(
      () => assertRealProfileLaunchAllowed({ ...LINUX_READY, storeCode: 'DL5477', platform }),
      (error) => error.code === LAUNCH_REJECT_CODES.PLATFORM_UNSUPPORTED,
    );
  }
  assert.throws(
    () => assertRealProfileLaunchAllowed({ ...LINUX_READY, storeCode: 'DL5477', gateExists: false }),
    (error) => error.code === LAUNCH_REJECT_CODES.GATE_MISSING,
  );
  assert.throws(
    () => assertRealProfileLaunchAllowed({
      ...LINUX_READY, storeCode: 'DL5477', availableDependencies: ['xvfb'],
    }),
    (error) => error.code === LAUNCH_REJECT_CODES.DEPENDENCY_MISSING,
  );
  assert.throws(
    () => assertRealProfileLaunchAllowed({ ...LINUX_READY, storeCode: 'DL' }),
    (error) => error.code === LAUNCH_REJECT_CODES.STORE_NOT_ALLOWED,
  );
  assert.throws(
    () => assertRealProfileLaunchAllowed({ ...LINUX_READY, storeCode: 'MZ2406', profileExists: false }),
    (error) => error.code === LAUNCH_REJECT_CODES.PROFILE_MISSING,
  );
  const allowed = assertRealProfileLaunchAllowed({ ...LINUX_READY, storeCode: 'MZ2406' });
  assert.equal(allowed.profileKey, 'persistent-mz2406-profile');
});

test('a catalog probe exposes technical metric ids only, sorted and bounded', async () => {
  const adapter = createWebApiExperimentAdapter({
    storeCode: 'DL5477',
    transport: async () => ({
      httpStatus: 200,
      // Deliberately unsorted. Duplicate ids remain a contract error upstream.
      body: { list: [{ metaIndexId: 353 }, { metaIndexId: 60 }] },
    }),
  });
  const result = await adapter.probeEndpoint('HOME_DATA_OVERVIEW_LIST');
  assert.deepEqual(result.discoveredMetaIndexIds, [60, 353]);
  assert.ok(Object.isFrozen(result.discoveredMetaIndexIds));
  // No value, label or currency travels with the ids.
  assert.equal(result.observations.length, 0);
  assert.doesNotMatch(JSON.stringify(result.batch), /"metaIndexId"|"label"/i);
});

test('a value endpoint and a permission endpoint expose no discovered ids', async () => {
  const detail = createWebApiExperimentAdapter({
    storeCode: 'MZ2406',
    transport: async () => ({
      httpStatus: 200,
      body: { list: [{ metaIndexId: 70, code: 'GSP000016', count: '12.34' }] },
    }),
  });
  const detailResult = await detail.probeEndpoint(
    'HOME_DATA_OVERVIEW_DETAIL',
    { metaIndexIds: [70] },
  );
  // A metric endpoint must not double as a discovery source.
  assert.deepEqual(detailResult.discoveredMetaIndexIds, []);
  assert.equal(detailResult.observations.length, 1);
  assert.equal(detailResult.observations[0].semanticStatus, SEMANTIC_STATUSES.UNMAPPED);

  const permission = createWebApiExperimentAdapter({
    storeCode: 'DL5477',
    transport: async () => ({ httpStatus: 200, body: { requestUri: '/x', systemCode: 'GSP' } }),
  });
  const permissionResult = await permission.probeEndpoint('HOME_KEY_INDICATOR_TRENDS');
  assert.deepEqual(permissionResult.discoveredMetaIndexIds, []);
});

test('a rejected envelope stores a FAILED batch with a schema hash and no discovered ids', async () => {
  const adapter = createWebApiExperimentAdapter({
    storeCode: 'DL5477',
    // The evidenced GMP envelope shape is not assumed here: an unexpected body
    // must fail closed rather than be reinterpreted.
    transport: async () => ({ httpStatus: 200, body: { code: '0', msg: 'ok', info: { meta: {} } } }),
  });
  const result = await adapter.probeEndpoint('HOME_DATA_OVERVIEW_LIST');
  assert.equal(result.batch.resultStatus, 'FAILED');
  assert.match(result.batch.responseSchemaHash, /^[0-9a-f]{64}$/);
  assert.match(result.batch.sanitizedErrorCode, /^[A-Z][A-Z0-9_]+$/);
  assert.deepEqual(result.discoveredMetaIndexIds, []);
  assert.equal(result.observations.length, 0);
  assert.deepEqual(result.responseSchemaPaths, [
    '$.code:string',
    '$.info.meta:object',
    '$.info:object',
    '$.msg:string',
    '$:object',
  ]);
});

test('schema path evidence is bounded, value-free and digests sensitive keys', () => {
  const value = {
    info: [{ metaIndexId: 60, label: 'never-output-this-value' }],
    accessToken: 'never-output-this-secret',
    'unexpected value key': 12,
  };
  const paths = schemaPathCatalog(value, { maxPaths: 20, maxDepth: 4 });
  const serialized = JSON.stringify(paths);
  assert.match(serialized, /\$\.info\[\]\.metaIndexId:number/);
  assert.match(serialized, /key_[0-9a-f]{12}/);
  assert.doesNotMatch(serialized, /accessToken|unexpected value key|never-output/i);
  assert.ok(paths.length <= 20);
  assert.ok(Object.isFrozen(paths));
});

test('the experiment layer never writes a formal fact, mart or dashboard value', async () => {
  const sources = await Promise.all([
    'src/webapi-experiment/adapter.mjs',
    'src/webapi-experiment/observation.mjs',
    'src/webapi-experiment/repository.mjs',
    'src/webapi-experiment/schema.mjs',
  ].map((path) => readFile(new URL(path, projectRoot), 'utf8')));
  const combined = sources.join('\n');
  assert.doesNotMatch(combined, /INSERT INTO\s+fact\./i);
  assert.doesNotMatch(combined, /INSERT INTO\s+mart\./i);
  assert.doesNotMatch(combined, /parseFloat|Number\(\s*(?:row|item)\?*\.count/);
  assert.doesNotMatch(combined, /set-cookie|authorization:/i);

  const migration = await readFile(
    new URL('db/migrations/0012_backfill_and_webapi_experiment.sql', projectRoot),
    'utf8',
  );
  assert.doesNotMatch(migration, /fact\.full_store_realtime_metric_snapshot/);
  assert.match(migration, /raw_decimal_value numeric\(38, 10\)/);
  assert.doesNotMatch(migration, /double precision|real\b|money/i);
  assert.match(migration, /experiment_gate = 'EXPERIMENT_ONLY'/);
});
