import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoots = ['src', 'scripts', 'tests'];
const supportedExtensions = new Set(['.js', '.mjs', '.cjs']);

function extension(path) {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index);
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => entry.name !== 'node_modules')
    .map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && supportedExtensions.has(extension(entry.name)) ? [path] : [];
    }));
  return nested.flat();
}

const files = (await Promise.all(
  sourceRoots.map((directory) => sourceFiles(resolve(projectRoot, directory))),
)).flat().sort();

let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`Syntax check failed: ${relative(projectRoot, file)}\n`);
    process.stderr.write(result.stderr || result.stdout || 'Unknown syntax error\n');
  }
}

if (failures > 0) {
  process.stderr.write(`${failures} source file(s) failed syntax validation.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Syntax validated: ${files.length} source and test files.\n`);
}
