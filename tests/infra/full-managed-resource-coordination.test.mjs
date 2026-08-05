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

test('a second browser requires four GiB and stricter host pressure', () => {
  assert.equal(
    RESOURCE_PRESSURE_PROFILES['browser-secondary'].minimumAvailableMemoryMiB,
    4096,
  );
  assert.deepEqual(parseArgs(['--class=browser-secondary']), {
    resourceClass: 'browser-secondary',
    systemdCondition: false,
  });
});

test('host lanes allow two read browsers while writes and heavy IO stay exclusive', async () => {
  const browserUnitNames = [
    'shein-fm-home-realtime.service',
    'shein-fm-home-daily.service',
    'shein-fm-home-daily-retry.service',
    'shein-fm-session-renewal.service',
  ];
  const browserUnits = await Promise.all(browserUnitNames.map((name) => (
    readFile(new URL(`infra/systemd/${name}`, root), 'utf8')
  )));
  for (const [index, unit] of browserUnits.entries()) {
    assert.match(unit, /^Slice=shein-host-heavy-fm\.slice$/m, browserUnitNames[index]);
    assert.match(unit, /run_shein_host_lane\.sh browser-read fm browser/);
    assert.match(unit, /shein-browser-read-0\.lock/);
    assert.match(unit, /shein-browser-read-1\.lock/);
  }

  const exclusiveUnitNames = [
    'shein-fm-db-backup.service',
    'shein-fm-db-restore-test.service',
    'shein-fm-dashboard-materialize.service',
    'shein-fm-dashboard-materialize-retry.service',
  ];
  const exclusiveUnits = await Promise.all(exclusiveUnitNames.map((name) => (
    readFile(new URL(`infra/systemd/${name}`, root), 'utf8')
  )));
  for (const [index, unit] of exclusiveUnits.entries()) {
    assert.match(unit, /^Slice=shein-host-heavy-fm\.slice$/m, exclusiveUnitNames[index]);
    if (exclusiveUnitNames[index].startsWith('shein-fm-dashboard-materialize')) {
      assert.match(unit, /run_full_managed_dashboard_materializer\.sh/);
    } else {
      assert.match(unit, /run_shein_host_lane\.sh io-heavy fm io-heavy/);
    }
  }

  for (const name of [
    'shein-fm-sales-sync.service',
    'shein-fm-supply-sync.service',
    'shein-fm-home-finance-daily.service',
  ]) {
    const unit = await readFile(new URL(`infra/systemd/${name}`, root), 'utf8');
    assert.match(unit, /^Slice=shein-fm-heavy\.slice$/m, name);
    assert.match(unit, /run_shein_host_lane\.sh api-light fm openapi/, name);
    assert.match(unit, /shein-api-light-0\.lock/, name);
    assert.match(unit, /shein-api-light-1\.lock/, name);
  }

  const [
    hostSlice,
    childSlice,
    fullManagedSlice,
    tmpfiles,
    laneWrapper,
    materializerWrapper,
  ] = await Promise.all([
    readFile(new URL('infra/systemd/shein-host-heavy.slice', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-host-heavy-fm.slice', root), 'utf8'),
    readFile(new URL('infra/systemd/shein-fm-heavy.slice', root), 'utf8'),
    readFile(new URL('infra/tmpfiles.d/shein-fm-scheduler.conf', root), 'utf8'),
    readFile(new URL('scripts/run_shein_host_lane.sh', root), 'utf8'),
    readFile(new URL('scripts/run_full_managed_dashboard_materializer.sh', root), 'utf8'),
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
  assert.match(tmpfiles, /f \/run\/lock\/shein-browser-read-0\.lock 0666 root root/);
  assert.match(tmpfiles, /f \/run\/lock\/shein-browser-read-1\.lock 0666 root root/);
  assert.match(laneWrapper, /flock -s -n 9/);
  assert.match(laneWrapper, /browser-secondary/);
  assert.match(laneWrapper, /browser-write\|db-heavy\|io-heavy/);
  assert.match(laneWrapper, /exec "\$@"/);
  assert.match(materializerWrapper, /run_shein_host_lane\.sh[\s\S]*db-heavy fm db-heavy/);
});

test('boot-sensitive timers never replay missed high-frequency work', async () => {
  const timers = await Promise.all([
    'shein-fm-home-realtime.timer',
    'shein-fm-sales-sync.timer',
    'shein-fm-dashboard-materialize.timer',
    'shein-fm-dashboard-materialize-retry.timer',
  ].map((name) => readFile(new URL(`infra/systemd/${name}`, root), 'utf8')));
  for (const timer of timers) {
    assert.doesNotMatch(timer, /Persistent=true/);
  }
  assert.doesNotMatch(timers[2], /OnBootSec=/);
  assert.doesNotMatch(timers[3], /OnBootSec=/);
});

test('shared runtime directories survive sequential oneshot jobs', async () => {
  const tmpfiles = await readFile(
    new URL('infra/tmpfiles.d/shein-fm-scheduler.conf', root),
    'utf8',
  );
  const groups = [
    {
      directory: 'shein-fm-webapi',
      owner: 'sheinfm',
      units: [
        'shein-fm-home-realtime.service',
        'shein-fm-home-daily.service',
        'shein-fm-home-daily-retry.service',
        'shein-fm-home-webapi-backfill.service',
        'shein-fm-session-renewal.service',
      ],
    },
    {
      directory: 'shein-fm-sales',
      owner: 'sheinfm-sales',
      units: [
        'shein-fm-sales-sync.service',
        'shein-fm-home-finance-daily.service',
        'shein-fm-home-finance-backfill.service',
      ],
    },
    {
      directory: 'shein-fm-supply',
      owner: 'sheinfm-supply',
      units: [
        'shein-fm-supply-sync.service',
        'shein-fm-purchase-order-history-backfill.service',
      ],
    },
  ];
  for (const group of groups) {
    assert.match(
      tmpfiles,
      new RegExp(`d /run/${group.directory} 0700 ${group.owner} ${group.owner} -`),
    );
    for (const name of group.units) {
      const unit = await readFile(
        new URL(`infra/systemd/${name}`, root),
        'utf8',
      );
      assert.match(unit, new RegExp(`^RuntimeDirectory=${group.directory}$`, 'm'), name);
      assert.match(unit, /^RuntimeDirectoryPreserve=yes$/m, name);
      assert.match(unit, new RegExp(`^ReadWritePaths=.*?/run/${group.directory}`, 'm'), name);
    }
  }
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
  const wrapper = await readFile(
    new URL('scripts/run_full_managed_dashboard_materializer.sh', root),
    'utf8',
  );
  assert.match(unit, /run_full_managed_dashboard_materializer\.sh/);
  assert.doesNotMatch(unit, /ExecStartPost=/);
  assert.match(unit, /^Environment=NODE_OPTIONS=--max-old-space-size=1152$/m);
  assert.match(unit, /^MemoryHigh=1024M$/m);
  assert.match(unit, /^MemoryMax=1536M$/m);
  assert.match(unit, /^MemorySwapMax=128M$/m);
  assert.match(promotion, /materialize_full_managed_dashboard\.mjs/);
  assert.match(promotion, /dashboard\.home\.next\.json/);
  assert.match(promotion, /dashboard\.next\.json/);
  assert.match(promotion, /mv -f "\$\{home_staging\}" "\$\{home_current\}"/);
  assert.match(promotion, /mv -f "\$\{core_staging\}" "\$\{core_current\}"/);
  assert.match(wrapper, /\.materialize-pending/);
  assert.match(wrapper, /materialize_status == 0/);
  assert.match(wrapper, /materialize_and_promote_full_managed_dashboard\.sh/);
});

test('scheduled data jobs coalesce successful and partial facts without rebuilding on failure', async () => {
  const unitNames = [
    'shein-fm-home-realtime.service',
    'shein-fm-home-daily.service',
    'shein-fm-home-daily-retry.service',
    'shein-fm-home-finance-daily.service',
    'shein-fm-sales-sync.service',
    'shein-fm-supply-sync.service',
  ];
  const units = await Promise.all(unitNames.map((name) => (
    readFile(new URL(`infra/systemd/${name}`, root), 'utf8')
  )));
  for (const [index, unit] of units.entries()) {
    assert.match(
      unit,
      /^OnSuccess=shein-fm-dashboard-materialize-enqueue\.service$/m,
      unitNames[index],
    );
    assert.doesNotMatch(unit, /^OnFailure=/m, unitNames[index]);
  }
  const enqueue = await readFile(
    new URL('infra/systemd/shein-fm-dashboard-materialize-enqueue.service', root),
    'utf8',
  );
  assert.match(enqueue, /enqueue_full_managed_dashboard_materialization\.sh/);
});
