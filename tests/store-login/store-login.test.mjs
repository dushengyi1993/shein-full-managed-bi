import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  FULL_MANAGED_STORE_CODES,
  fullManagedProfileKey,
  fullManagedRuntimeSlot,
  normalizeFullManagedStoreCode,
} from '../../src/config/full-managed-stores.mjs';
import {
  createBatch,
  sha256,
} from '../../scripts/create_full_managed_store_login_batch.mjs';
import { createStoreLoginServer } from '../../scripts/serve_full_managed_store_login.mjs';

test('the login roster contains 24 unique canonical Profiles and runtime slots', () => {
  assert.equal(FULL_MANAGED_STORE_CODES.length, 24);
  assert.equal(new Set(FULL_MANAGED_STORE_CODES).size, 24);
  assert.equal(normalizeFullManagedStoreCode('dl5477'), 'DL5477');
  assert.equal(normalizeFullManagedStoreCode('DL'), null);
  assert.equal(new Set(FULL_MANAGED_STORE_CODES.map(fullManagedProfileKey)).size, 24);
  assert.equal(
    new Set(FULL_MANAGED_STORE_CODES.map((storeCode) => fullManagedRuntimeSlot(storeCode).debuggingPort)).size,
    24,
  );
});

test('a batch persists only a hash while the one-time token remains caller-only', () => {
  const bytes = Buffer.alloc(32, 7);
  const batch = createBatch({
    now: new Date('2026-07-30T00:00:00.000Z'),
    expiresHours: 24,
    randomBytes: () => bytes,
  });
  assert.equal(batch.record.tokenHash, sha256(batch.token));
  assert.equal(JSON.stringify(batch.record).includes(batch.token), false);
  assert.equal(batch.record.expiresAt, '2026-07-31T00:00:00.000Z');
});

test('the login server is constructible without opening a listener', () => {
  const server = createStoreLoginServer();
  assert.equal(server.listening, false);
  server.close();
});

test('store login routes never put the batch bearer into a query parameter', async () => {
  const source = await readFile(
    new URL('../../scripts/serve_full_managed_store_login.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /searchParams\.get\(['"]token/);
  assert.match(source, /headers\.authorization/);
  assert.match(source, /--password-store=basic/);
  assert.doesNotMatch(source, /document\.cookie|localStorage\.getItem|Network\.getAllCookies/);
});
