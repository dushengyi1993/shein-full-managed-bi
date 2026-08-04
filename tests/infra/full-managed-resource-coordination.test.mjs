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
  SYSTEMD_CONDITION_DEFER_EXIT_CODE,
} from '../../scripts/check_full_managed_resource_pressure.mjs';

const root = new URL('../../', import.meta.url);

test('resource pressure parsers accept only bounded Linux pressure facts', () => {
  assert.equal(parseUptimeSeconds('1200.50 20.00\n'), 1200.5);
  assert.equal(parseLoadAverage('1.25 1.00 0.50 1/100 20\n'), 1.25);
  assert.equal(parseMemAvailableMiB('MemTotal: 8000000 kB\nMemAvailable: 3145728 kB\n'), 3072);
  assert.equal(parsePressureFullAvg10('some avg10=20.00\nfull avg10=3.50 avg60=1.00\n'), 3.5);
  assert.equal(parsePressureFullAvg10('some avg10=20.00\n'), null);
  assert.deepEqual(parseArgs(['--class=browser']), {
    resourceClass: 'browser',
    systemdCondition: false,
  });
  assert.deepEqual(parseArgs(['--class=browser', '--systemd-condition']), {
    resourceClass: 'browser',
    systemdCondition: true,
  });
  assert.throws(() => parseArgs([]), /RESOURCE_PRESSURE_CLASS_REQUIRED/);
  assert.equal(RESOURCE_PRESSURE_DEFER_EXIT_CODE, 75);
  assert.equal(SYSTEMD_CONDITION_DEFER_EXIT_CODE, 1);
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

test('host-heavy jobs share the neutral lock while sales stays in the light lane', async () => {
  const heavyUnitNames = [
    'shein-fm-home-realtime.service',
    'shein-fm-home-daily.service',
    'shein-fm-home-daily-retry.service',
    'shein-fm-home-finance-daily.service',
    'shein-fm-supply-sync.service',
    'shein-fm-session-renewal.service',
    'shein-fm-db-backup.service',
    'shein-fm-backup-archive.service',
    'shein-fm-dashboard-materialize.service',
  ];
  const heavyUnits = await Promise.all(heavyUnitNames.map((name) => (
    readFile(new URL(`infra/systemd/${name}`, root), 'utf8')
  )));
  for (const [index, unit] of heavyUnits.entries()) {
    assert.match(
      unit,
      /^Slice=shein-host-heavy-fm\.slice$/m,
      heavyUnitNames[index],
    );
    assert.match(
      unit,
      /\/run\/lock\/shein-host-heavy\.lock.*\/run\/lock\/shein-fm-heavy\.lock/,
    );
    assert.match(unit, /run_full_managed_resource_guarded\.sh \w+/);
    assert.doesNotMatch(unit, /^ExecCondition=/m);
    assert.match(unit, /^CPUWeight=\d+$/m);
    assert.match(unit, /^Nice=\d+$/m);
  }

  const sales = await readFile(
    new URL('infra/systemd/shein-fm-sales-sync.service', root),
    'utf8',
  );
  assert.match(sales, /^Slice=shein-fm-heavy\.slice$/m);
  assert.match(
    sales,
    /check_full_managed_resource_pressure\.mjs --class=openapi --systemd-condition/,
  );
  assert.doesNotMatch(sales, /shein-host-heavy/);
  assert.doesNotMatch(sales, /\/run\/lock\/shein-fm-heavy\.lock/);
  assert.match(sales, /\/run\/shein-fm-sales\/sync\.lock/);

  const [hostSlice, childSlice, fullManagedSlice, tmpfiles, wrapper] = await Promise.all([
    readFile(new URL('infra/systemd/shein-host-heavy.slice', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-host-heavy-fm.slice', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-heavy.slice', root), 'utf8'),
    readFile(new URL('infra/tmpfiles.d/shein-fm-scheduler.conf', root), 'utf8'),
    readFile(new URL('scripts/run_full_managed_resource_guarded.sh', root), 'utf8'),
  ]);
  assert.match(hostSlice, /CPUQuota=90%/);
  assert.match(hostSlice, /MemoryHigh=3G/);
  assert.match(hostSlice, /MemoryMax=4G/);
  assert.match(childSlice, /CPUQuota=90%/);
  assert.match(childSlice, /MemoryHigh=2G/);
  assert.match(childSlice, /MemoryMax=3G/);
  assert.match(fullManagedSlice, /MemoryMax=3G/);
  assert.match(tmpfiles, /f \/run\/lock\/shein-host-heavy\.lock 0666 root root/);
  assert.match(tmpfiles, /f \/run\/lock\/shein-fm-heavy\.lock 0666 root root/);
  assert.match(wrapper, /check_full_managed_resource_pressure\.mjs/);
  assert.match(wrapper, /exec "\$@"/);
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
