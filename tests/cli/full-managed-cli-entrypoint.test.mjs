import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI_SCRIPTS = [
  'finalize_full_managed_authorization_receipt.mjs',
  'migrate_full_managed_store_inventory.mjs',
  'reject_full_managed_authorization_receipt.mjs',
  'report_full_managed_authorization_status.mjs',
];

test('CLI entrypoints execute through a deployment current-directory link', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fm-cli-entrypoint-'));
  const currentLink = path.join(directory, 'current');
  try {
    await symlink(
      PROJECT_ROOT,
      currentLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    for (const scriptName of CLI_SCRIPTS) {
      const script = path.join(currentLink, 'scripts', scriptName);
      let failure;
      try {
        await execFileAsync(process.execPath, [script, '--entrypoint-probe'], {
          cwd: currentLink,
          env: process.env,
          windowsHide: true,
        });
      } catch (error) {
        failure = error;
      }

      assert.ok(failure, `${scriptName} should execute and reject the probe argument`);
      assert.notEqual(failure.code, 0);
      assert.equal(failure.stdout, '');
      const response = JSON.parse(String(failure.stderr).trim());
      assert.equal(response.ok, false);
      assert.match(response.errorCode, /^[A-Z0-9_]{3,80}$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
