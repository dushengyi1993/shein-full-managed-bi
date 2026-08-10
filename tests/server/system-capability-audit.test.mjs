import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { SYSTEM_CAPABILITY_AUDIT } from '../../src/server/system-capability-audit.mjs';

const EXPECTED_ITEM_KEYS = Object.freeze([
  'third-party-applications',
  'material-applications',
  'store-decoration',
  'service-market',
  'certificate-testing',
]);

function collectStringValues(value, sink) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringValues(item, sink));
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStringValues(child, sink);
    return;
  }
  if (typeof value === 'string') sink.push(value);
}

test('capability audit is a single-store evidence scope with unknown portfolio coverage', () => {
  assert.equal(SYSTEM_CAPABILITY_AUDIT.schemaVersion, 1);
  assert.equal(SYSTEM_CAPABILITY_AUDIT.evidenceScope, 'ONE_LIVE_STORE');
  assert.equal(SYSTEM_CAPABILITY_AUDIT.portfolioCoverageStatus, 'UNKNOWN');
  assert.equal(SYSTEM_CAPABILITY_AUDIT.observedTimePrecision, 'DATE');
  assert.match(SYSTEM_CAPABILITY_AUDIT.auditVersion, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.match(SYSTEM_CAPABILITY_AUDIT.observedDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('the five audited items never claim portfolio completeness', () => {
  assert.equal(SYSTEM_CAPABILITY_AUDIT.items.length, 5);
  assert.deepEqual(
    SYSTEM_CAPABILITY_AUDIT.items.map((item) => item.key),
    EXPECTED_ITEM_KEYS,
  );
  for (const item of SYSTEM_CAPABILITY_AUDIT.items) {
    assert.equal(item.portfolioCoverageStatus, 'UNKNOWN');
    assert.ok(['AUDITED', 'PARTIAL_AUDIT'].includes(item.capabilityStatus));
    assert.ok(item.label);
    assert.ok(item.placement);
    assert.ok(item.readModel);
    assert.ok(item.excluded);
    assert.ok(['WEBAPI_INTERNAL', 'WEBAPI_EXTERNAL'].includes(item.sourceClass));
  }

  const serialized = JSON.stringify(SYSTEM_CAPABILITY_AUDIT);
  assert.doesNotMatch(serialized, /25\/25/);
  assert.doesNotMatch(serialized, /25 店已采集|25 店覆盖完整|25 店全部/);
  assert.doesNotMatch(serialized, /portfolioCoverageStatus":"(?!UNKNOWN)/);
  assert.doesNotMatch(serialized, /evidenceScope":"(?!ONE_LIVE_STORE)/);
});

test('audit hash is a stable sha256 over the sanitized payload', () => {
  const { auditHash, ...payload } = SYSTEM_CAPABILITY_AUDIT;
  assert.match(auditHash, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    auditHash,
  );
});

test('audit carries no raw credentials, keys or PII values', () => {
  const serialized = JSON.stringify(SYSTEM_CAPABILITY_AUDIT);
  const credentialKey = /secret|token|password|cookie|authorization|apikey|accesskey|credential|session/i;
  const keys = [];
  const collectKeys = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collectKeys);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        keys.push(key);
        collectKeys(value[key]);
      }
    }
  };
  collectKeys(SYSTEM_CAPABILITY_AUDIT);
  assert.deepEqual(keys.filter((key) => credentialKey.test(key)), []);

  const values = [];
  collectStringValues(SYSTEM_CAPABILITY_AUDIT, values);
  for (const value of values) {
    assert.doesNotMatch(value, /1[3-9]\d{9}/, `mobile number in ${value}`);
    assert.doesNotMatch(value, /\d{11,}/, `long digit run in ${value}`);
    assert.doesNotMatch(value, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, `email in ${value}`);
  }
  assert.doesNotMatch(serialized, /"secret[^"]*":/i);
  assert.doesNotMatch(serialized, /"token[^"]*":/i);
  assert.doesNotMatch(serialized, /"password[^"]*":/i);
  assert.doesNotMatch(serialized, /"accessKey[^"]*":/i);
});

test('every item documents its explicit write and sensitive-field exclusion', () => {
  for (const item of SYSTEM_CAPABILITY_AUDIT.items) {
    assert.ok(item.excluded.length > 0);
    assert.match(item.excluded, /(写|授权|取消|申领|退回|导出|打印|编辑|提交|新建|订购|验收|评价|重置)/);
  }
});
