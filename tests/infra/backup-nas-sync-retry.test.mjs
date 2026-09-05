import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE_PATH = new URL('../../infra/systemd/shein-fm-backup-sync-nas.service', import.meta.url);

function parseSystemdUnit(content) {
  const sections = {};
  let currentSection = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0 && currentSection) {
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim();
      sections[currentSection][key] = val;
    }
  }
  return sections;
}

test('shein-fm-backup-sync-nas.service adheres strictly to bounded exit 75 retry contract', async () => {
  const content = await readFile(SERVICE_PATH, 'utf8');
  const unit = parseSystemdUnit(content);

  // [Unit] rate limit assertions: 3 burst attempts per 20min interval
  assert.ok(unit.Unit, 'Unit section must exist');
  assert.equal(unit.Unit.StartLimitIntervalSec, '20min', 'StartLimitIntervalSec must be 20min');
  assert.equal(unit.Unit.StartLimitBurst, '3', 'StartLimitBurst must be bounded to 3 attempts');

  // [Service] type must be exec so that RestartForceExitStatus is legally accepted by systemd
  assert.ok(unit.Service, 'Service section must exist');
  assert.equal(unit.Service.Type, 'exec', 'Service type must be exec because oneshot forbids RestartForceExitStatus');

  // Restart strategy: default no restart for exit 0 or permanent exit 1; only force-restart on exit 75
  assert.equal(unit.Service.Restart, 'no', 'Restart default must be no to fail closed on permanent errors');
  assert.equal(unit.Service.RestartForceExitStatus, '75', 'Only exit 75 (IO stall/resource busy) forces auto-restart');
  assert.equal(unit.Service.RestartSec, '60s', 'RestartSec must wait 60s cooldown before retrying');

  // Runtime limits: must use RuntimeMaxSec instead of TimeoutStartSec for Type=exec
  assert.equal(unit.Service.RuntimeMaxSec, '25min', 'RuntimeMaxSec must bound whole execution to 25min');
  assert.equal(unit.Service.TimeoutStartSec, undefined, 'TimeoutStartSec must not be used to bound execution of Type=exec');
  assert.equal(unit.Service.TimeoutStopSec, '30s', 'TimeoutStopSec must retain 30s stop grace period');
  assert.equal(unit.Service.KillMode, 'control-group', 'KillMode must be control-group');

  // Retain isolation, security and resource constraints
  assert.equal(unit.Service.NoNewPrivileges, 'true');
  assert.equal(unit.Service.PrivateTmp, 'true');
  assert.equal(unit.Service.ProtectSystem, 'strict');
  assert.equal(unit.Service.ProtectHome, 'true');
  assert.equal(unit.Service.CPUQuota, '50%');
  assert.equal(unit.Service.IOWeight, '10');
  assert.equal(unit.Service.MemoryMax, '512M');
});

test('systemd-analyze verify proves legality and counterexamples prove oneshot forbids RestartForceExitStatus', async () => {
  try {
    const { stdout, stderr } = await execFileAsync('wsl', [
      'bash', '-c', 'systemd-analyze verify infra/systemd/shein-fm-backup-sync-nas.service 2>&1',
    ]);
    const output = (stdout + stderr).toLowerCase();
    assert.equal(output.includes('refusing'), false, 'Official unit must not be refused by systemd');
    assert.equal(output.includes('bad unit file setting'), false, 'Official unit must not have bad settings');

    const badOneshotUnit = '[Unit]\\nDescription=bad\\n[Service]\\nType=oneshot\\nExecStart=/bin/true\\nRestart=no\\nRestartForceExitStatus=75\\n';
    const badCheck = await execFileAsync('wsl', [
      'bash', '-c', `printf "${badOneshotUnit}" > /tmp/bad_oneshot.service && systemd-analyze verify /tmp/bad_oneshot.service 2>&1 || true`,
    ]);
    assert.match(badCheck.stdout, /Service has RestartForceExitStatus= set, which isn't allowed for Type=oneshot services. Refusing./);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
});
