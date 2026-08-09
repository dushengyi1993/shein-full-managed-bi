export const ZERO_OID_PATTERN = /^0{40,64}$/;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/;
const RELEASE_TAG_REF_PATTERN = /^refs\/tags\/\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const ARCHIVE_TAG_REF_PATTERN = /^refs\/tags\/archive\//;

export function isZeroOid(value) {
  return ZERO_OID_PATTERN.test(value ?? '');
}

export function isReleaseTagRef(ref) {
  return RELEASE_TAG_REF_PATTERN.test(ref ?? '');
}

export function isArchiveTagRef(ref) {
  return ARCHIVE_TAG_REF_PATTERN.test(ref ?? '');
}

export function parsePrePushUpdates(input) {
  const lines = String(input ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    const parts = line.split(/\s+/u);
    if (parts.length !== 4) {
      throw new Error(`invalid pre-push update line: ${line}`);
    }
    const [localRef, localOid, remoteRef, remoteOid] = parts;
    if (!OBJECT_ID_PATTERN.test(localOid) || !OBJECT_ID_PATTERN.test(remoteOid)) {
      throw new Error(`invalid object id in pre-push update: ${line}`);
    }
    return Object.freeze({ localRef, localOid, remoteRef, remoteOid });
  });
}

function issue(code, ref, message) {
  return Object.freeze({ code, ref, message });
}

export function evaluatePushUpdates({
  updates,
  remoteMainOid,
  archivedOids = new Set(),
  isAncestor,
  resolveCommit,
}) {
  if (!Array.isArray(updates)) throw new TypeError('updates must be an array');
  if (typeof isAncestor !== 'function') throw new TypeError('isAncestor must be a function');
  if (typeof resolveCommit !== 'function') throw new TypeError('resolveCommit must be a function');

  const issues = [];
  const mainUpdate = updates.find(({ remoteRef }) => remoteRef === 'refs/heads/main');
  let projectedMainOid = remoteMainOid || null;

  if (mainUpdate) {
    if (isZeroOid(mainUpdate.localOid)) {
      issues.push(issue(
        'MAIN_DELETE_FORBIDDEN',
        mainUpdate.remoteRef,
        'main may not be deleted',
      ));
    } else {
      projectedMainOid = resolveCommit(mainUpdate.localOid);
      if (
        remoteMainOid
        && !isZeroOid(remoteMainOid)
        && !isAncestor(remoteMainOid, projectedMainOid)
      ) {
        issues.push(issue(
          'MAIN_NON_FAST_FORWARD_FORBIDDEN',
          mainUpdate.remoteRef,
          'main must move by fast-forward',
        ));
      }
    }
  }

  for (const update of updates) {
    if (isReleaseTagRef(update.remoteRef)) {
      if (isZeroOid(update.localOid)) {
        issues.push(issue(
          'RELEASE_TAG_DELETE_FORBIDDEN',
          update.remoteRef,
          'release tags are immutable',
        ));
      } else if (!projectedMainOid) {
        issues.push(issue(
          'MAIN_REF_REQUIRED',
          update.remoteRef,
          'remote main is required before a release tag can be pushed',
        ));
      } else {
        const releaseCommit = resolveCommit(update.localOid);
        if (!isAncestor(releaseCommit, projectedMainOid)) {
          issues.push(issue(
            'RELEASE_NOT_ON_MAIN',
            update.remoteRef,
            'release tag target must already be reachable from main',
          ));
        }
      }
    }

    if (isArchiveTagRef(update.remoteRef) && isZeroOid(update.localOid)) {
      issues.push(issue(
        'ARCHIVE_TAG_DELETE_FORBIDDEN',
        update.remoteRef,
        'archive tags are immutable audit anchors',
      ));
    }

    if (
      update.remoteRef.startsWith('refs/heads/')
      && update.remoteRef !== 'refs/heads/main'
      && isZeroOid(update.localOid)
      && !isZeroOid(update.remoteOid)
    ) {
      if (!projectedMainOid) {
        issues.push(issue(
          'MAIN_REF_REQUIRED',
          update.remoteRef,
          'remote main is required before a branch can be deleted',
        ));
      } else if (
        !isAncestor(update.remoteOid, projectedMainOid)
        && !archivedOids.has(update.remoteOid)
      ) {
        issues.push(issue(
          'UNMERGED_BRANCH_DELETE_FORBIDDEN',
          update.remoteRef,
          'branch tip is neither merged into main nor preserved by a remote archive tag',
        ));
      }
    }
  }

  return Object.freeze({
    ok: issues.length === 0,
    projectedMainOid,
    issues: Object.freeze(issues),
  });
}
