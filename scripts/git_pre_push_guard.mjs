import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  evaluatePushUpdates,
  parsePrePushUpdates,
} from './lib/version_management.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const remote = process.argv[2] || 'origin';

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

function remoteMainOid() {
  const output = git(['ls-remote', '--heads', remote, 'refs/heads/main']).stdout.trim();
  if (!output) return null;
  return output.split(/\s+/u)[0];
}

function remoteArchiveOids() {
  const output = git(['ls-remote', '--tags', remote, 'refs/tags/archive/*']).stdout;
  return new Set(output
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[0])
    .filter(Boolean));
}

function main() {
  const updates = parsePrePushUpdates(readFileSync(0, 'utf8'));
  if (updates.length === 0) return;

  const result = evaluatePushUpdates({
    updates,
    remoteMainOid: remoteMainOid(),
    archivedOids: remoteArchiveOids(),
    isAncestor,
    resolveCommit,
  });

  if (!result.ok) {
    for (const item of result.issues) {
      process.stderr.write(`version guard: ${item.code} ${item.ref}: ${item.message}\n`);
    }
    process.stderr.write('See docs/version-management.md before retrying.\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('version guard: ok\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`version guard: ${error.message}\n`);
  process.exitCode = 1;
}
