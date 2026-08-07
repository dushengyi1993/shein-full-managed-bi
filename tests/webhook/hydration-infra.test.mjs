import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('webhook hydration migration adds leases without widening worker fact access', async () => {
  const migration = await read('db/migrations/0027_webhook_projection_hydration.sql');
  const verify = await read('db/verify/0027_webhook_projection_hydration.sql');
  const reconcile = await read('db/migrations/9999_runtime_role_reconcile.sql');
  assert.match(migration, /lease_owner text NOT NULL/);
  assert.match(migration, /lease_expires_at timestamptz/);
  assert.match(migration, /GRANT SELECT, UPDATE ON ops\.webhook_hydration_directive\s+TO sheinfm_supply_loader/);
  assert.doesNotMatch(migration, /GRANT INSERT[\s\S]*sheinfm_supply_loader/);
  assert.match(verify, /has_table_privilege\([\s\S]*sheinfm_supply_loader[\s\S]*SELECT,UPDATE/);
  assert.match(reconcile, /GRANT SELECT, UPDATE ON ops\.webhook_hydration_directive/);
});

test('systemd crosses the webhook privilege boundary only through fixed markers', async () => {
  const worker = await read('infra/systemd/shein-fm-webhook-worker.service');
  const dashboardPath = await read('infra/systemd/shein-fm-webhook-dashboard-enqueue.path');
  const hydrationPath = await read('infra/systemd/shein-fm-webhook-hydration.path');
  const hydrationService = await read('infra/systemd/shein-fm-webhook-hydration.service');
  const hydrationTimer = await read('infra/systemd/shein-fm-webhook-hydration.timer');
  const tmpfiles = await read('infra/tmpfiles.d/shein-fm-scheduler.conf');
  assert.match(worker, /ReadWritePaths=\/srv\/shein-fm\/runtime\/webhook-requests/);
  assert.match(dashboardPath, /Unit=shein-fm-dashboard-materialize-enqueue\.service/);
  assert.match(hydrationPath, /Unit=shein-fm-webhook-hydration\.service/);
  assert.match(hydrationService, /User=sheinfm-supply/);
  assert.match(hydrationService, /run_shein_host_lane\.sh api-light/);
  assert.match(hydrationService, /OnSuccess=shein-fm-dashboard-materialize-enqueue\.service/);
  assert.match(hydrationTimer, /Persistent=false/);
  assert.match(tmpfiles, /webhook-requests 0700 sheinfm-webhook-worker sheinfm-webhook-worker/);
});
