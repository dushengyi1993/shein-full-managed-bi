import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FULL_MANAGED_STORE_CODES } from '../../src/config/full-managed-stores.mjs';

const manifest = JSON.parse(await readFile(
  new URL('../../config/full-managed-legal-entities.json', import.meta.url),
  'utf8',
));

test('24 full-managed stores are assigned exactly once to 17 legal entities', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.entities.length, 17);

  const entityKeys = manifest.entities.map((entity) => entity.entityKey);
  const stores = manifest.entities.flatMap((entity) => entity.stores);

  assert.equal(new Set(entityKeys).size, 17);
  assert.equal(stores.length, 24);
  assert.equal(new Set(stores).size, 24);
  assert.deepEqual(
    [...stores].sort(),
    [...FULL_MANAGED_STORE_CODES].sort(),
  );
});

test('same-company stores share one Open Platform Profile', () => {
  for (const entity of manifest.entities) {
    assert.match(entity.entityKey, /^[A-Z]{2}$/);
    assert.equal(typeof entity.legalName, 'string');
    assert.ok(entity.legalName.length >= 4);
    assert.equal(entity.profileKey, `persistent-${entity.entityKey.toLowerCase()}-profile`);
    assert.ok(entity.stores.length >= 1);
  }

  assert.deepEqual(
    manifest.entities.find((entity) => entity.entityKey === 'NM').stores,
    ['NM7397', 'NM4977', 'NM8787', 'NM8831'],
  );
  assert.deepEqual(
    manifest.entities.find((entity) => entity.entityKey === 'RH').stores,
    ['RH0099', 'RH2848'],
  );
});
