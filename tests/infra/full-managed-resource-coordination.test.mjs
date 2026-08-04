import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  evaluateResourcePressure,
  parseArgs,
  parseLoadAverage,
  parseMemAvailableMiB,
  parsePressureFullAvg10,
  parseUptimeSeconds,
  RESOURCE_PRESSURE_DEFER_EXIT_CODE,
  RESOURCE_PRESSURE_PROFILES,
} from '../../scripts/check_full_managed_resource_pressure.mjs';

const root = new URL('../../', import.meta.url);

test('resource pressure parsers accept only bounded Linux pressure facts', () => {
  assert.equal(parseUptimeSeconds('1200.50 20.00\n'), 1200.5);
  assert.equal(parseLoadAverage('1.25 1.00 0.50 1/100 20\n'), 1.25);
  assert.equal(parseMemAvailableMiB('MemTotal: 8000000 kB\nMemAvailable: 3145728 kB\n'), 3072);
  assert.equal(parsePressureFullAvg10('some avg10=20.00\nfull avg10=3.50 avg60=1.00\n'), 3.5);
  assert.equal(parsePressureFullAvg10('some avg10=20.00\n'), null);
  assert.deepEqual(parseArgs(['--class=browser']), { resourceClass: 'browser' });
  assert.throws(() => parseArgs([]), /RESOURCE_PRESSURE_CLASS_REQUIRED/);
  assert.equal(RESOURCE_PRESSURE_DEFER_EXIT_CODE, 75);
});

test('resource pressure gate defers boot, memory, CPU and IO storms', () => {
  const profile = RESOURCE_PRESSURE_PROFILES.browser;
  const result = evaluateResourcePressure({
    uptimeSeconds: 120,
    cpuCount: 2,
    load1: 6.8,
    availableMemoryMiB: 1800,
    memoryFullAvg10: 2.5,
    ioFullAvg10: 20,
  }, profile);
  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, [
    'BOOT_SETTLING',
    'MEMORY_PRESSURE',
    'CPU_LOAD_PRESSURE',
    'MEMORY_STALL_PRESSURE',
    'IO_STALL_PRESSURE',
  ]);
});

test('resource pressure gate accepts an idle settled host', () => {
  const result = evaluateResourcePressure({
    uptimeSeconds: 3600,
    cpuCount: 2,
    load1: 0.8,
    availableMemoryMiB: 4096,
    memoryFullAvg10: 0,
    ioFullAvg10: 0.2,
  }, RESOURCE_PRESSURE_PROFILES.materializer);
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.evidence.normalizedLoad, 0.4);
});

test('high-frequency full-managed jobs share one bounded systemd envelope', async () => {
  const unitNames = [
    'shein-fm-home-realtime.service',
    'shein-fm-sales-sync.service',
    'shein-fm-dashboard-materialize.service',
  ];
  const units = await Promise.all(unitNames.map((name) => (
    readFile(new URL(`infra/systemd/${name}`, root), 'utf8')
  )));
  for (const [index, unit] of units.entries()) {
    assert.match(unit, /^Slice=shein-fm-heavy\.slice$/m, unitNames[index]);
    assert.match(unit, /check_full_managed_resource_pressure\.mjs --class=/);
    assert.match(unit, /\/run\/lock\/shein-fm-heavy\.lock/);
    assert.match(unit, /^CPUWeight=\d+$/m);
    assert.match(unit, /^Nice=\d+$/m);
  }

  const [slice, tmpfiles] = await Promise.all([
    readFile(new URL('infra/systemd/shein-fm-heavy.slice', root), 'utf8'),
    readFile(new URL('infra/tmpfiles.d/shein-fm-scheduler.conf', root), 'utf8'),
  ]);
  assert.match(slice, /CPUQuota=90%/);
  assert.match(slice, /MemoryHigh=2G/);
  assert.match(slice, /MemoryMax=3G/);
  assert.match(slice, /MemorySwapMax=256M/);
  assert.match(tmpfiles, /f \/run\/lock\/shein-fm-heavy\.lock 0666 root root/);
});

test('boot-sensitive timers never replay missed high-frequency work', async () => {
  const timers = await Promise.all([
    'shein-fm-home-realtime.timer',
    'shein-fm-sales-sync.timer',
    'shein-fm-dashboard-materialize.timer',
  ].map((name) => readFile(new URL(`infra/systemd/${name}`, root), 'utf8')));
  for (const timer of timers) {
    assert.doesNotMatch(timer, /Persistent=true/);
  }
  assert.doesNotMatch(timers[2], /OnBootSec=/);
});

test('materializer lock deferral cannot publish nonexistent staging files', async () => {
  const unit = await readFile(
    new URL('infra/systemd/shein-fm-dashboard-materialize.service', root),
    'utf8',
  );
  const promotion = await readFile(
    new URL('scripts/materialize_and_promote_full_managed_dashboard.sh', root),
    'utf8',
  );
  assert.match(unit, /flock -n -E 75 .*materialize_and_promote_full_managed_dashboard\.sh/);
  assert.doesNotMatch(unit, /ExecStartPost=/);
  assert.match(promotion, /materialize_full_managed_dashboard\.mjs/);
  assert.match(promotion, /dashboard\.home\.next\.json/);
  assert.match(promotion, /dashboard\.next\.json/);
  assert.match(promotion, /mv -f "\$\{home_staging\}" "\$\{home_current\}"/);
  assert.match(promotion, /mv -f "\$\{core_staging\}" "\$\{core_current\}"/);
});
