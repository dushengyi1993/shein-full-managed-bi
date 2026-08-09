import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluatePushUpdates,
  isArchiveTagRef,
  isReleaseTagRef,
  parsePrePushUpdates,
} from '../../scripts/lib/version_management.mjs';

const ZERO = '0'.repeat(40);
const MAIN_OLD = '1'.repeat(40);
const MAIN_NEW = '2'.repeat(40);
const MERGED = '3'.repeat(40);
const UNMERGED = '4'.repeat(40);
const TAG_OBJECT = '5'.repeat(40);

function update(localRef, localOid, remoteRef, remoteOid) {
  return { localRef, localOid, remoteRef, remoteOid };
}

function evaluate(updates, {
  archivedOids = new Set(),
  ancestors = new Set([
    `${MAIN_OLD}:${MAIN_NEW}`,
    `${MERGED}:${MAIN_OLD}`,
    `${MERGED}:${MAIN_NEW}`,
  ]),
  resolved = new Map([[TAG_OBJECT, UNMERGED]]),
} = {}) {
  return evaluatePushUpdates({
    updates,
    remoteMainOid: MAIN_OLD,
    archivedOids,
    isAncestor: (ancestor, descendant) => (
      ancestor === descendant || ancestors.has(`${ancestor}:${descendant}`)
    ),
    resolveCommit: (oid) => resolved.get(oid) ?? oid,
  });
}

test('pre-push input is parsed without losing delete records', () => {
  const parsed = parsePrePushUpdates([
    `refs/heads/topic ${MERGED} refs/heads/topic ${ZERO}`,
    `(delete) ${ZERO} refs/heads/old ${MERGED}`,
  ].join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].remoteRef, 'refs/heads/old');
  assert.equal(parsed[1].localOid, ZERO);
});

test('release and archive tags use separate policies', () => {
  assert.equal(isReleaseTagRef('refs/tags/2026.08.09.2'), true);
  assert.equal(isReleaseTagRef('refs/tags/archive/old-ui'), false);
  assert.equal(isArchiveTagRef('refs/tags/archive/old-ui'), true);
});

test('main cannot be deleted or force-pushed', () => {
  const deletion = evaluate([
    update('(delete)', ZERO, 'refs/heads/main', MAIN_OLD),
  ]);
  assert.deepEqual(deletion.issues.map(({ code }) => code), ['MAIN_DELETE_FORBIDDEN']);

  const forcePush = evaluate([
    update('refs/heads/main', UNMERGED, 'refs/heads/main', MAIN_OLD),
  ]);
  assert.deepEqual(forcePush.issues.map(({ code }) => code), [
    'MAIN_NON_FAST_FORWARD_FORBIDDEN',
  ]);
});

test('release tags must be immutable and already reachable from projected main', () => {
  const releaseRef = 'refs/tags/2026.08.10.1';
  const rejected = evaluate([
    update(releaseRef, TAG_OBJECT, releaseRef, ZERO),
  ]);
  assert.deepEqual(rejected.issues.map(({ code }) => code), ['RELEASE_NOT_ON_MAIN']);

  const accepted = evaluate([
    update('refs/heads/main', MAIN_NEW, 'refs/heads/main', MAIN_OLD),
    update(releaseRef, MERGED, releaseRef, ZERO),
  ]);
  assert.equal(accepted.ok, true);

  const deletion = evaluate([
    update('(delete)', ZERO, releaseRef, MERGED),
  ]);
  assert.deepEqual(deletion.issues.map(({ code }) => code), [
    'RELEASE_TAG_DELETE_FORBIDDEN',
  ]);
});

test('branch deletion requires merge ancestry or an immutable archive tag', () => {
  const merged = evaluate([
    update('(delete)', ZERO, 'refs/heads/merged', MERGED),
  ]);
  assert.equal(merged.ok, true);

  const rejected = evaluate([
    update('(delete)', ZERO, 'refs/heads/unmerged', UNMERGED),
  ]);
  assert.deepEqual(rejected.issues.map(({ code }) => code), [
    'UNMERGED_BRANCH_DELETE_FORBIDDEN',
  ]);

  const archived = evaluate([
    update('(delete)', ZERO, 'refs/heads/unmerged', UNMERGED),
  ], { archivedOids: new Set([UNMERGED]) });
  assert.equal(archived.ok, true);
});

test('archive tags cannot be deleted through the guarded clone', () => {
  const result = evaluate([
    update('(delete)', ZERO, 'refs/tags/archive/old-ui', TAG_OBJECT),
  ]);
  assert.deepEqual(result.issues.map(({ code }) => code), [
    'ARCHIVE_TAG_DELETE_FORBIDDEN',
  ]);
});
