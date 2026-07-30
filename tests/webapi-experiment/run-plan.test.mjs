import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CATALOG_ENDPOINT_CODES,
  EXPERIMENT_MODES,
  EXPERIMENT_STAGES,
  ExperimentPlanError,
  METRIC_DETAIL_ENDPOINT_CODES,
  assertExperimentExecuteAuthorization,
  buildWebApiExperimentPlan,
} from '../../src/webapi-experiment/run-plan.mjs';
import {
  buildExperimentPlanReport,
} from '../../scripts/plan_full_managed_webapi_experiment.mjs';
import {
  parseExperimentRunRequest,
  toSafeDryRunReport,
  runExperimentPlan,
} from '../../scripts/run_full_managed_webapi_experiment.mjs';
import { assertSafeCliOutput } from '../../src/backfill/cli-support.mjs';
import { TRANSPORT_REJECT_CODES } from '../../src/webapi-experiment/page-transport.mjs';

const CATALOG_BASE = Object.freeze({
  stage: 'CATALOG',
  storeCodes: ['DL5477'],
  endpointCodes: ['HOME_DATA_OVERVIEW_LIST', 'HOME_KEY_INDICATOR_TRENDS'],
  createdBy: 'codex.batch4',
});

const CATALOG_ARGS = Object.freeze([
  '--stage=CATALOG',
  '--stores=DL5477',
  '--endpoints=HOME_DATA_OVERVIEW_LIST,HOME_KEY_INDICATOR_TRENDS',
  '--created-by=codex.batch4',
]);

test('the two stages own disjoint, evidence-derived endpoint sets', () => {
  assert.deepEqual([...CATALOG_ENDPOINT_CODES], [
    'HOME_DATA_OVERVIEW_LIST',
    'HOME_KEY_INDICATOR_TRENDS',
    'HOME_TEMPLATE_LIST',
  ]);
  assert.deepEqual([...METRIC_DETAIL_ENDPOINT_CODES], [
    'HOME_DATA_OVERVIEW_DETAIL',
    'HOME_V4_DETAIL',
  ]);
  for (const code of CATALOG_ENDPOINT_CODES) {
    assert.ok(!METRIC_DETAIL_ENDPOINT_CODES.includes(code), code);
  }
});

test('plan hash is deterministic across input ordering', () => {
  const first = buildWebApiExperimentPlan(CATALOG_BASE);
  const second = buildWebApiExperimentPlan({
    ...CATALOG_BASE,
    storeCodes: ['dl5477', 'DL5477'],
    endpointCodes: ['HOME_KEY_INDICATOR_TRENDS', 'HOME_DATA_OVERVIEW_LIST'],
  });
  assert.equal(first.planHash, second.planHash);
  assert.match(first.planHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    first.probes.map((probe) => `${probe.storeCode}:${probe.endpointCode}`),
    ['DL5477:HOME_DATA_OVERVIEW_LIST', 'DL5477:HOME_KEY_INDICATOR_TRENDS'],
  );
  // A different scope must not collide.
  assert.notEqual(
    first.planHash,
    buildWebApiExperimentPlan({ ...CATALOG_BASE, storeCodes: ['MZ2406'] }).planHash,
  );
});

test('a catalog plan refuses value endpoints and metric ids', () => {
  assert.throws(
    () => buildWebApiExperimentPlan({ ...CATALOG_BASE, endpointCodes: ['HOME_V4_DETAIL'] }),
    (error) => error.code === 'ENDPOINT_NOT_ALLOWED_FOR_STAGE',
  );
  assert.throws(
    () => buildWebApiExperimentPlan({ ...CATALOG_BASE, metaIndexIds: [70] }),
    (error) => error.code === 'CATALOG_REJECTS_META_INDEX_IDS',
  );
  const plan = buildWebApiExperimentPlan(CATALOG_BASE);
  assert.equal(plan.summary.carriesMetricValues, false);
  assert.equal(plan.summary.metaIndexIdCount, 0);
});

test('metric detail requires explicit bounded metric ids and the right endpoints', () => {
  const base = {
    stage: 'METRIC_DETAIL',
    storeCodes: ['MZ2406'],
    endpointCodes: ['HOME_DATA_OVERVIEW_DETAIL'],
    createdBy: 'codex.batch4',
  };
  assert.throws(
    () => buildWebApiExperimentPlan(base),
    (error) => error.code === 'METRIC_DETAIL_REQUIRES_META_INDEX_IDS',
  );
  assert.throws(
    () => buildWebApiExperimentPlan({ ...base, metaIndexIds: [] }),
    (error) => error.code === 'METRIC_DETAIL_REQUIRES_META_INDEX_IDS',
  );
  for (const invalid of [[0], [-1], ['abc'], [1_000_001], [1.5]]) {
    assert.throws(
      () => buildWebApiExperimentPlan({ ...base, metaIndexIds: invalid }),
      (error) => error.code === 'META_INDEX_ID_INVALID',
      String(invalid),
    );
  }
  assert.throws(
    () => buildWebApiExperimentPlan({
      ...base,
      metaIndexIds: Array.from({ length: 51 }, (_unused, index) => index + 1),
    }),
    (error) => error.code === 'META_INDEX_ID_COUNT_INVALID',
  );
  assert.throws(
    () => buildWebApiExperimentPlan({
      ...base,
      endpointCodes: ['HOME_TEMPLATE_LIST'],
      metaIndexIds: [70],
    }),
    (error) => error.code === 'ENDPOINT_NOT_ALLOWED_FOR_STAGE',
  );

  const plan = buildWebApiExperimentPlan({ ...base, metaIndexIds: ['71', 70, 70] });
  assert.deepEqual([...plan.metaIndexIds], [70, 71]);
  assert.deepEqual(plan.probes[0].request, { metaIndexIds: [70, 71] });
  assert.equal(plan.summary.carriesMetricValues, true);
});

test('templateType is required exactly when a requested endpoint accepts it', () => {
  // HOME_TEMPLATE_LIST carries a templateType query.
  assert.throws(
    () => buildWebApiExperimentPlan({
      ...CATALOG_BASE,
      endpointCodes: ['HOME_TEMPLATE_LIST'],
    }),
    (error) => error.code === 'TEMPLATE_TYPE_REQUIRED',
  );
  const withTemplate = buildWebApiExperimentPlan({
    ...CATALOG_BASE,
    endpointCodes: ['HOME_TEMPLATE_LIST'],
    templateType: '1',
  });
  assert.equal(withTemplate.templateType, 1);
  assert.deepEqual(withTemplate.probes[0].request, { templateType: 1 });
  // An endpoint that takes no templateType must not receive one.
  assert.throws(
    () => buildWebApiExperimentPlan({ ...CATALOG_BASE, templateType: '1' }),
    (error) => error.code === 'TEMPLATE_TYPE_NOT_REQUIRED',
  );
  // HOME_V4_DETAIL needs both ids and a templateType.
  assert.throws(
    () => buildWebApiExperimentPlan({
      stage: 'METRIC_DETAIL',
      storeCodes: ['DL5477'],
      endpointCodes: ['HOME_V4_DETAIL'],
      metaIndexIds: [426],
      createdBy: 'codex.batch4',
    }),
    (error) => error.code === 'TEMPLATE_TYPE_REQUIRED',
  );
  const v4 = buildWebApiExperimentPlan({
    stage: 'METRIC_DETAIL',
    storeCodes: ['DL5477'],
    endpointCodes: ['HOME_V4_DETAIL'],
    metaIndexIds: [426],
    templateType: 0,
    createdBy: 'codex.batch4',
  });
  assert.deepEqual(v4.probes[0].request, { metaIndexIds: [426], templateType: 0 });
});

test('only the configured canonical stores and an explicit operator are accepted', () => {
  for (const stores of [[], ['DL'], ['MZ'], ['ZZ0000'], ['']]) {
    assert.throws(() => buildWebApiExperimentPlan({ ...CATALOG_BASE, storeCodes: stores }),
      ExperimentPlanError, String(stores));
  }
  assert.throws(
    () => buildWebApiExperimentPlan({ ...CATALOG_BASE, createdBy: '' }),
    (error) => error.code === 'CREATED_BY_INVALID',
  );
  assert.throws(
    () => buildWebApiExperimentPlan({ ...CATALOG_BASE, stage: 'DISCOVERY' }),
    (error) => error.code === 'STAGE_INVALID',
  );
});

test('execute authorization requires the exact hash and exact set equality', () => {
  const plan = buildWebApiExperimentPlan({ ...CATALOG_BASE, storeCodes: ['DL5477', 'MZ2406'] });
  const good = {
    plan,
    approvedPlanHash: plan.planHash,
    allowedStoreCodes: ['MZ2406', 'DL5477'],
    allowedEndpointCodes: [...plan.endpointCodes],
  };
  const authorization = assertExperimentExecuteAuthorization(good);
  assert.equal(authorization.planHash, plan.planHash);
  assert.deepEqual([...authorization.allowedStoreCodes], ['DL5477', 'MZ2406']);

  assert.throws(
    () => assertExperimentExecuteAuthorization({ ...good, approvedPlanHash: 'b'.repeat(64) }),
    (error) => error.code === 'PLAN_HASH_MISMATCH',
  );
  assert.throws(
    () => assertExperimentExecuteAuthorization({ ...good, approvedPlanHash: 'nope' }),
    (error) => error.code === 'MISSING_APPROVED_PLAN_HASH',
  );
  // A subset is refused.
  assert.throws(
    () => assertExperimentExecuteAuthorization({ ...good, allowedStoreCodes: ['DL5477'] }),
    (error) => error.code === 'STORE_SCOPE_NOT_EXACT',
  );
  // A superset is refused just as loudly, so approval cannot silently widen.
  assert.throws(
    () => assertExperimentExecuteAuthorization({
      ...good,
      allowedEndpointCodes: [...plan.endpointCodes, 'HOME_TEMPLATE_LIST'],
    }),
    (error) => error.code === 'ENDPOINT_SCOPE_NOT_EXACT',
  );
  assert.throws(
    () => assertExperimentExecuteAuthorization({ ...good, allowedStoreCodes: [] }),
    (error) => error.code === 'MISSING_ALLOWED_STORES',
  );
});

test('the planner CLI is deterministic, safe and side-effect free', () => {
  const report = buildExperimentPlanReport(CATALOG_ARGS);
  assert.equal(report.mode, 'DRY_RUN');
  assert.equal(report.stage, EXPERIMENT_STAGES.CATALOG);
  assert.equal(report.storeCount, 1);
  assert.equal(report.probeCount, 2);
  assert.equal(report.carriesMetricValues, false);
  assert.match(report.planHash, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertSafeCliOutput(report));
  assert.equal(buildExperimentPlanReport([...CATALOG_ARGS].reverse()).planHash, report.planHash);
  // Unknown and duplicate flags are refused per entrypoint.
  assert.throws(() => buildExperimentPlanReport([...CATALOG_ARGS, '--allow-stores=DL5477']),
    (error) => error.code === 'CLI_FLAG_UNKNOWN');
  assert.throws(() => buildExperimentPlanReport([...CATALOG_ARGS, '--stage=CATALOG']),
    (error) => error.code === 'CLI_FLAG_DUPLICATED');
});

test('the runner CLI defaults to dry-run and demands explicit execute scope', () => {
  const dryRun = parseExperimentRunRequest(CATALOG_ARGS);
  assert.equal(dryRun.mode, EXPERIMENT_MODES.DRY_RUN);
  assert.equal(dryRun.authorization, undefined);

  const report = toSafeDryRunReport(dryRun.plan);
  // Acceptance 1: a dry-run performs no session, transport or repository work.
  assert.equal(report.sessionsOpened, 0);
  assert.equal(report.transportsCreated, 0);
  assert.equal(report.repositoriesCreated, 0);
  assert.equal(report.databaseConnections, 0);
  assert.match(report.planHash, /^[0-9a-f]{64}$/);
  assert.doesNotThrow(() => assertSafeCliOutput(report));

  assert.throws(() => parseExperimentRunRequest([...CATALOG_ARGS, '--execute']),
    (error) => error.code === 'CLI_FLAG_REQUIRED');
  assert.throws(
    () => parseExperimentRunRequest([...CATALOG_ARGS, '--allow-stores=DL5477']),
    (error) => error.code === 'CLI_EXECUTE_FLAG_WITHOUT_EXECUTE',
  );
  const authorized = parseExperimentRunRequest([
    ...CATALOG_ARGS,
    '--execute',
    `--approved-plan-hash=${dryRun.plan.planHash}`,
    '--allow-stores=DL5477',
    '--allow-endpoints=HOME_DATA_OVERVIEW_LIST,HOME_KEY_INDICATOR_TRENDS',
  ]);
  assert.equal(authorized.mode, EXPERIMENT_MODES.EXECUTE);
  assert.equal(authorized.authorization.planHash, dryRun.plan.planHash);
});

test('an authorized execute run is sequential, persists once and always cleans up', async () => {
  const plan = buildWebApiExperimentPlan({ ...CATALOG_BASE, storeCodes: ['DL5477', 'MZ2406'] });
  const events = [];
  let openSessions = 0;
  let maxOpenSessions = 0;

  const result = await runExperimentPlan({
    plan,
    authorization: { allowedStoreCodes: [...plan.storeCodes] },
    deps: {
      async openSession({ storeCode }) {
        openSessions += 1;
        maxOpenSessions = Math.max(maxOpenSessions, openSessions);
        events.push(`open:${storeCode}`);
        return {
          storeCode,
          profileKey: `persistent-${storeCode.toLowerCase()}-profile`,
          sessionState: 'ACTIVE',
          evaluate: async () => ({}),
          async close() {
            openSessions -= 1;
            events.push(`close:${storeCode}`);
          },
        };
      },
      createTransport: () => async () => ({ httpStatus: 200, body: { list: [] } }),
      createAdapter: ({ storeCode }) => ({
        async probeEndpoint(endpointCode) {
          events.push(`probe:${storeCode}:${endpointCode}`);
          return {
            batch: {
              storeCode,
              endpointCode,
              resultStatus: 'SCHEMA_ONLY',
              httpStatus: 200,
              requestSchemaHash: 'a'.repeat(64),
              responseSchemaHash: 'b'.repeat(64),
              payloadFingerprint: 'c'.repeat(64),
              observationCount: 0,
              rejectedCount: 0,
              sanitizedErrorCode: null,
            },
            observations: [],
            rejected: [],
            discoveredMetaIndexIds: [60, 353],
            responseSchemaPaths: ['$:object', '$.list:array'],
          };
        },
      }),
      repository: {
        async recordExperimentResult() {
          events.push('persist');
          return { webapiFetchBatchId: 1 };
        },
        async recordSessionHealth() {
          events.push('health');
          return { recorded: true };
        },
      },
    },
  });

  // One canonical Profile at a time.
  assert.equal(maxOpenSessions, 1);
  assert.equal(result.sessionsOpened, 2);
  assert.equal(openSessions, 0, 'every session must be closed');
  assert.deepEqual(events.filter((item) => item.startsWith('open') || item.startsWith('close')), [
    'open:DL5477', 'close:DL5477', 'open:MZ2406', 'close:MZ2406',
  ]);
  // Acceptance 2: technical ids travel; no label or value exists in the output.
  assert.deepEqual(result.probes[0].discoveredMetaIndexIds, [60, 353]);
  assert.deepEqual(result.probes[0].responseSchemaPaths, ['$:object', '$.list:array']);
  assert.equal(result.probes[0].persisted, true);
  assert.doesNotThrow(() => assertSafeCliOutput(result));
  // The safe projection carries no Profile key and no metric label.
  assert.doesNotMatch(JSON.stringify(result), /persistent-|profileKey|pageLabel/);
});

test('a failing store is recorded as blocked, closed, and does not stop the next store', async () => {
  const plan = buildWebApiExperimentPlan({ ...CATALOG_BASE, storeCodes: ['DL5477', 'MZ2406'] });
  const closed = [];
  const result = await runExperimentPlan({
    plan,
    authorization: { allowedStoreCodes: [...plan.storeCodes] },
    deps: {
      sessionStateForFailure: () => 'BLOCKED',
      async openSession({ storeCode }) {
        if (storeCode === 'DL5477') {
          const error = new Error('refused');
          error.code = 'WEBAPI_SESSION_IDENTITY_UNPROVEN';
          throw error;
        }
        return {
          storeCode,
          profileKey: `persistent-${storeCode.toLowerCase()}-profile`,
          sessionState: 'ACTIVE',
          evaluate: async () => ({}),
          async close() { closed.push(storeCode); },
        };
      },
      createTransport: () => async () => ({ httpStatus: 200, body: {} }),
      createAdapter: ({ storeCode }) => ({
        async probeEndpoint(endpointCode) {
          return {
            batch: {
              storeCode,
              endpointCode,
              resultStatus: 'FAILED',
              httpStatus: 200,
              responseSchemaHash: 'd'.repeat(64),
              observationCount: 0,
              rejectedCount: 0,
              // Acceptance 4: an unexpected envelope stores a FAILED batch plus a
              // schema hash and a sanitized code, and nothing is broadened.
              sanitizedErrorCode: 'WEBAPI_RESPONSE_SHAPE_INVALID',
            },
            observations: [],
            rejected: [],
            discoveredMetaIndexIds: [],
          };
        },
      }),
      repository: {
        async recordExperimentResult() { return { webapiFetchBatchId: 2 }; },
        async recordSessionHealth() { return { recorded: true }; },
      },
    },
  });
  assert.equal(result.ok, false);
  const blocked = result.probes.find((probe) => probe.storeCode === 'DL5477');
  assert.equal(blocked.resultStatus, 'BLOCKED');
  assert.equal(blocked.sanitizedErrorCode, 'WEBAPI_SESSION_IDENTITY_UNPROVEN');
  const failed = result.probes.find((probe) => probe.storeCode === 'MZ2406');
  assert.equal(failed.resultStatus, 'FAILED');
  assert.equal(failed.responseSchemaHash, 'd'.repeat(64));
  assert.deepEqual(closed, ['MZ2406']);
  assert.doesNotThrow(() => assertSafeCliOutput(result));
});

test('an HTTP-200 auth-expired probe is persisted, marks the Profile expired and stops that store', async () => {
  const plan = buildWebApiExperimentPlan({
    ...CATALOG_BASE,
    endpointCodes: ['HOME_DATA_OVERVIEW_LIST', 'HOME_KEY_INDICATOR_TRENDS'],
  });
  const health = [];
  const attempted = [];
  const result = await runExperimentPlan({
    plan,
    authorization: { allowedStoreCodes: [...plan.storeCodes] },
    deps: {
      async openSession({ storeCode }) {
        return {
          storeCode,
          profileKey: 'persistent-dl5477-profile',
          sessionState: 'ACTIVE',
          async close() {},
        };
      },
      createTransport: () => async () => ({ httpStatus: 200, body: {} }),
      createAdapter: () => ({
        async probeEndpoint(endpointCode) {
          attempted.push(endpointCode);
          return {
            batch: {
              storeCode: 'DL5477',
              endpointCode,
              resultStatus: 'FAILED',
              httpStatus: null,
              requestedAt: '2026-07-28T01:00:00.000Z',
              completedAt: '2026-07-28T01:00:01.250Z',
              requestSchemaHash: 'a'.repeat(64),
              responseSchemaHash: null,
              payloadFingerprint: null,
              observationCount: 0,
              rejectedCount: 0,
              sanitizedErrorCode: TRANSPORT_REJECT_CODES.AUTH_EXPIRED,
            },
            observations: [],
            rejected: [],
            discoveredMetaIndexIds: [],
          };
        },
      }),
      repository: {
        async recordExperimentResult() { return { webapiFetchBatchId: 3 }; },
        async recordSessionHealth(entry) {
          health.push(entry);
          return { recorded: true };
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(attempted.length, 1, 'the remaining endpoint must not run after auth expiry');
  assert.equal(result.probes.length, 1);
  assert.equal(result.probes[0].persisted, true);
  assert.equal(health[0].sessionState, 'ACTIVE', 'identity proof is recorded first');
  assert.equal(health[1].sessionState, 'EXPIRED');
  assert.equal(health[1].latencyMs, 1250);
  assert.equal(health[1].sanitizedErrorCode, TRANSPORT_REJECT_CODES.AUTH_EXPIRED);
  assert.equal(result.healthAppends, 2);
  assert.doesNotThrow(() => assertSafeCliOutput(result));
});
