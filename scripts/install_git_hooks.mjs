import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function git(args) {
  const result = spawnSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

try {
  const topLevel = git(['rev-parse', '--show-toplevel']).replaceAll('\\', '/');
  if (topLevel.toLowerCase() !== projectRoot.replaceAll('\\', '/').replace(/\/$/u, '').toLowerCase()) {
    throw new Error(`unexpected repository root: ${topLevel}`);
  }
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  git(['config', '--local', 'fetch.prune', 'true']);
  const hookPath = git(['config', '--local', '--get', 'core.hooksPath']);
  const fetchPrune = git(['config', '--local', '--get', 'fetch.prune']);
  if (hookPath !== '.githooks') throw new Error(`hook path readback mismatch: ${hookPath}`);
  if (fetchPrune !== 'true') throw new Error(`fetch.prune readback mismatch: ${fetchPrune}`);
  process.stdout.write('Git safeguards installed: core.hooksPath=.githooks, fetch.prune=true\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
