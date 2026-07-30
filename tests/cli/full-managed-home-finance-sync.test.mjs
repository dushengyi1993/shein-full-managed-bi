import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../../scripts/sync_full_managed_home_finance.mjs';
import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

const BASE = [
  `--stores=${FULL_MANAGED_STORE_CODES.join(',')}`,
  '--from=2023-06-07',
  '--to=2026-07-30',
  '--config=/tmp/openapi.json',
];

test('finance history accepts the exact 24-store roster and resumes with bounded concurrency', () => {
  const args = parseArgs([...BASE, '--concurrency=4']);
  assert.deepEqual(args.stores, [...FULL_MANAGED_STORE_CODES]);
  assert.equal(args.resume, true);
  assert.equal(args.concurrency, 4);
  assert.equal(args.execute, false);
});

test('finance history rejects stores outside the roster and unsafe concurrency', () => {
  assert.throws(() => parseArgs([
    '--stores=ZZ0000',
    '--from=2023-06-07',
    '--to=2026-07-30',
    '--config=/tmp/openapi.json',
  ]), /FINANCE_CLI_SCOPE_REQUIRED/);
  for (const concurrency of ['0', '5', '1.5', 'many']) {
    assert.throws(
      () => parseArgs([...BASE, `--concurrency=${concurrency}`]),
      /FINANCE_CLI_ARGUMENT_INVALID/,
    );
  }
});
