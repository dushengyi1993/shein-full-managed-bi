import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isReleaseTagRef } from './lib/version_management.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1] ?? fallback;
  return fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function git(args, { allowStatus = [] } = {}) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status === 0 || allowStatus.includes(result.status)) return result;
  const detail = (result.stderr || result.stdout || '').trim();
  throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
}

function resolveCommit(ref) {
  return git(['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();
}

function isAncestor(ancestor, descendant) {
  return git(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    { allowStatus: [1] },
  ).status === 0;
}

function releaseTagRefs() {
  return git(['for-each-ref', '--format=%(refname)', 'refs/tags']).stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((ref) => ref && isReleaseTagRef(ref));
}

function main() {
  const mainRef = flagValue('main-ref', 'origin/main');
  const mainCommit = resolveCommit(mainRef);
  const allReleaseTags = hasFlag('all-release-tags');
  const refs = allReleaseTags
    ? releaseTagRefs()
    : [flagValue('release-ref', 'HEAD')];

  const failures = [];
  const checked = refs.map((ref) => {
    const commit = resolveCommit(ref);
    const reachable = isAncestor(commit, mainCommit);
    if (!reachable) failures.push({ ref, commit });
    return { ref, commit, reachable };
  });

  const result = {
    ok: failures.length === 0,
    mainRef,
    mainCommit,
    checkedCount: checked.length,
    failures,
  };
  if (!allReleaseTags) result.checked = checked;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
