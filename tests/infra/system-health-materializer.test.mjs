import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildSystemHealthSnapshot,
  parseSystemctlShow,
  projectUnit,
  sanitizeLoginState,
  sanitizeRenewalReport,
  systemdTimestampToIso,
} from '../../scripts/materialize_full_managed_system_health.mjs';

test('systemd timestamps are converted from Shanghai CST without the JavaScript CST trap', () => {
  assert.equal(
    systemdTimestampToIso('Sat 2026-08-01 02:46:08 CST'),
    '2026-07-31T18:46:08.000Z',
  );
  assert.equal(systemdTimestampToIso(''), null);
});

test('systemctl projection keeps failed oneshots visible even when inactive', () => {
  const definition = {
    key: 'sessionRenewal',
    label: 'Profile 续期',
    service: 'shein-fm-session-renewal.service',
    timer: 'shein-fm-session-renewal.timer',
    kind: 'job',
    critical: false,
    route: 'system',
  };
  const service = parseSystemctlShow([
    'LoadState=loaded',
    'ActiveState=failed',
    'SubState=failed',
    'Result=exit-code',
    'ExecMainStatus=2',
    'InactiveEnterTimestamp=Fri 2026-07-31 15:33:31 CST',
  ].join('\n'));
  const timer = parseSystemctlShow([
    'LoadState=loaded',
    'ActiveState=active',
    'SubState=waiting',
    'LastTriggerUSec=Fri 2026-07-31 03:28:25 CST',
    'NextElapseUSecRealtime=Sat 2026-08-01 03:29:10 CST',
  ].join('\n'));
  const row = projectUnit(definition, service, timer);
  assert.equal(row.state, 'attention');
  assert.equal(row.exitStatus, 2);
  assert.equal(row.lastRunAt, '2026-07-30T19:28:25.000Z');
  assert.equal(row.nextRunAt, '2026-07-31T19:29:10.000Z');
});

test('Profile projections expose only status evidence and discard private fields', () => {
  const login = sanitizeLoginState({
    updatedAt: '2026-07-31T08:16:54.000Z',
    stores: {
      DL5477: {
        status: 'completed',
        verified: true,
        completedAt: '2026-07-31T08:00:00.000Z',
        lastError: 'Cookie=secret',
        password: 'do-not-project',
      },
    },
  });
  const renewal = sanitizeRenewalReport({
    generatedAt: '2026-07-31T07:33:27.000Z',
    completedProfileCount: 1,
    activeCount: 0,
    results: [{
      storeCode: 'DL5477',
      state: 'EXPIRED',
      renewed: false,
      errorCode: 'WEBAPI_SESSION_AUTH_EXPIRED',
      cookie: 'do-not-project',
    }],
  });
  const serialized = JSON.stringify({ login, renewal });
  assert.match(serialized, /DL5477/);
  assert.match(serialized, /WEBAPI_SESSION_AUTH_EXPIRED/);
  assert.doesNotMatch(serialized, /Cookie=secret|do-not-project|password|cookie/i);
  assert.equal(login.rows.length, 25);
});

test('runtime snapshot contains only allow-listed releases, units, disks and Profile evidence', () => {
  const snapshot = buildSystemHealthSnapshot({
    generatedAt: '2026-08-01T00:00:00.000Z',
    units: [{
      key: 'portal',
      label: 'BI 门户',
      kind: 'daemon',
      critical: true,
      route: 'system',
      state: 'healthy',
    }],
    loginState: { stores: {} },
    renewalReport: { results: [] },
    disks: [{
      filesystem: '/',
      checkedAt: '2026-08-01T00:00:00.000Z',
      usedPercent: 47.2,
      warningPercent: 75,
      criticalPercent: 85,
      severity: 'ok',
      observeOnly: true,
    }],
    currentRelease: 'a'.repeat(40),
    previousRelease: '../../../secret',
  });
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.releases.current, 'a'.repeat(40));
  assert.equal(snapshot.releases.previous, null);
  assert.equal(snapshot.disks[0].usedPercent, 47.2);
});

test('system-health unit is networkless, read-only outside the dashboard projection and hides secrets', async () => {
  const unit = await readFile(
    new URL('../../infra/systemd/shein-fm-system-health.service', import.meta.url),
    'utf8',
  );
  const script = await readFile(
    new URL('../../scripts/materialize_full_managed_system_health.mjs', import.meta.url),
    'utf8',
  );
  assert.match(unit, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(unit, /ProtectSystem=strict/);
  assert.match(unit, /ReadWritePaths=\/srv\/shein-fm\/runtime\/dashboard/);
  assert.match(unit, /InaccessiblePaths=\/srv\/shein-fm\/secrets \/srv\/shein-fm\/webapi\/profiles/);
  assert.doesNotMatch(
    script,
    /process\.env\.[A-Z_]*(TOKEN|SECRET|PASSWORD)|headers?\[['"]Authorization|item\.(cookie|password|accessToken|refreshToken)/i,
  );
});
