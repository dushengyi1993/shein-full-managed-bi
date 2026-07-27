import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeOwnerRoster,
  ownerRosterPlanHash,
} from '../../scripts/sync_full_managed_owner_roster.mjs';

const roster = {
  version: 'FM-ROSTER-2026-07-26-v1',
  effectiveAt: '2026-07-26T00:00:00+08:00',
  owners: [
    {
      key: 'FM-OWNER-001',
      username: 'fm-owner-001',
      displayName: '负责人一',
      storeCodes: ['CX4412', 'XL2801'],
    },
    {
      key: 'FM-OWNER-002',
      username: 'fm-owner-002',
      displayName: '负责人二',
      storeCodes: ['DL5477'],
    },
  ],
};

test('normalizes a full-managed owner roster without exposing login credentials', () => {
  const normalized = normalizeOwnerRoster(roster);
  assert.deepEqual(normalized.storeCodes, ['CX4412', 'DL5477', 'XL2801']);
  assert.equal(normalized.effectiveAt, '2026-07-25T16:00:00.000Z');
  assert.equal(normalized.owners[0].displayName, '负责人一');
});

test('rejects a store assigned to more than one full-managed owner', () => {
  assert.throws(
    () => normalizeOwnerRoster({
      ...roster,
      owners: [
        roster.owners[0],
        { ...roster.owners[1], storeCodes: ['CX4412'] },
      ],
    }),
    /more than one owner/,
  );
});

test('plan hash changes when warehouse assignments drift', () => {
  const normalized = normalizeOwnerRoster(roster);
  const first = ownerRosterPlanHash(normalized, { stores: normalized.storeCodes, principals: [], assignments: [] });
  const second = ownerRosterPlanHash(normalized, {
    stores: normalized.storeCodes,
    principals: [],
    assignments: [{ storeCode: 'CX4412', ownerKey: 'FM-OWNER-001', role: 'PRIMARY' }],
  });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});
