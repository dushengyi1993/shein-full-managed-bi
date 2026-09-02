import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const SYSTEMD_DIR = new URL('infra/systemd/', ROOT);
const PROXY_ENV_PATH = '/srv/shein-fm/secrets/openapi-proxy.env';
const PROXY_ENV_DIRECTIVE = `EnvironmentFile=${PROXY_ENV_PATH}`;
const OPENAPI_UNITS = Object.freeze([
  'shein-fm-home-finance-backfill.service',
  'shein-fm-home-finance-daily.service',
  'shein-fm-home-realtime.service',
  'shein-fm-purchase-order-history-backfill.service',
  'shein-fm-sales-sync.service',
  'shein-fm-supply-sync.service',
  'shein-fm-webhook-hydration.service',
]);

async function text(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

async function systemdServices() {
  const names = (await readdir(SYSTEMD_DIR))
    .filter((name) => name.endsWith('.service'))
    .sort();
  return Promise.all(names.map(async (name) => ({
    name,
    content: await readFile(new URL(name, SYSTEMD_DIR), 'utf8'),
  })));
}

test('undici is locked exactly to the non-vulnerable 7.29.0 release', async () => {
  const manifest = JSON.parse(await text('package.json'));
  const lock = JSON.parse(await text('package-lock.json'));

  assert.equal(manifest.dependencies.undici, '7.29.0');
  assert.equal(lock.packages[''].dependencies.undici, '7.29.0');
  assert.equal(lock.packages['node_modules/undici'].version, '7.29.0');
  assert.equal(
    lock.packages['node_modules/undici'].resolved,
    'https://registry.npmjs.org/undici/-/undici-7.29.0.tgz',
  );
});

test('exactly the seven credential-bearing OpenAPI business units require the proxy env', async () => {
  const services = await systemdServices();
  const credentialBearingUnits = services
    .filter(({ content }) => (
      /FULL_BI_OPENAPI_CONFIG_FILE=\/srv\/shein-fm\/secrets\/(?:sales|supply)\/openapi\.json/.test(content)
      || /LoadCredential=sales_openapi_config:\/srv\/shein-fm\/secrets\/sales\/openapi\.json/.test(content)
    ))
    .map(({ name }) => name)
    .sort();
  const wiredUnits = services
    .filter(({ content }) => content.split(/\r?\n/).includes(PROXY_ENV_DIRECTIVE))
    .map(({ name }) => name)
    .sort();

  assert.deepEqual(credentialBearingUnits, OPENAPI_UNITS);
  assert.deepEqual(wiredUnits, OPENAPI_UNITS);

  for (const { name, content } of services) {
    const lines = content.split(/\r?\n/);
    assert.doesNotMatch(
      content,
      /^Environment=(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)=/m,
      `${name} must not set a process-wide proxy`,
    );
    if (!OPENAPI_UNITS.includes(name)) continue;
    assert.equal(
      lines.filter((line) => line === PROXY_ENV_DIRECTIVE).length,
      1,
      `${name} must require the proxy env exactly once`,
    );
    assert.doesNotMatch(
      content,
      new RegExp(`^EnvironmentFile=-${PROXY_ENV_PATH.replaceAll('/', '\\/')}\\s*$`, 'm'),
      `${name} must fail before ExecStart when the proxy env is absent`,
    );
    const proxyEnvironmentFileIndex = lines.indexOf(PROXY_ENV_DIRECTIVE);
    const otherEnvironmentFileIndexes = lines
      .map((line, index) => (
        line.startsWith('EnvironmentFile=') && line !== PROXY_ENV_DIRECTIVE
          ? index
          : -1
      ))
      .filter((index) => index >= 0);
    assert.ok(
      otherEnvironmentFileIndexes.every((index) => index < proxyEnvironmentFileIndex),
      `${name} must load the proxy env after every other EnvironmentFile`,
    );
    assert.match(content, /^Environment=SHEIN_FM_CLOUD_EXECUTION=1$/m);
  }
});

test('the seven unit entrypoints retain real official OpenAPI call chains', async () => {
  const [
    salesUnit,
    supplyUnit,
    financeDailyUnit,
    financeBackfillUnit,
    realtimeUnit,
    purchaseBackfillUnit,
    hydrationUnit,
    scheduled,
    coordinator,
    sales,
    supply,
    finance,
    purchaseBackfill,
    backfillRuntime,
    hydration,
  ] = await Promise.all([
    text('infra/systemd/shein-fm-sales-sync.service'),
    text('infra/systemd/shein-fm-supply-sync.service'),
    text('infra/systemd/shein-fm-home-finance-daily.service'),
    text('infra/systemd/shein-fm-home-finance-backfill.service'),
    text('infra/systemd/shein-fm-home-realtime.service'),
    text('infra/systemd/shein-fm-purchase-order-history-backfill.service'),
    text('infra/systemd/shein-fm-webhook-hydration.service'),
    text('scripts/run_full_managed_scheduled_task.mjs'),
    text('scripts/run_full_managed_business_coordinator.mjs'),
    text('scripts/sync_full_managed_sales.mjs'),
    text('scripts/sync_full_managed_supply.mjs'),
    text('scripts/sync_full_managed_home_finance.mjs'),
    text('scripts/backfill_full_managed_purchase_order_history.mjs'),
    text('scripts/run_full_managed_backfill.mjs'),
    text('scripts/run_full_managed_webhook_hydration.mjs'),
  ]);

  assert.match(salesUnit, /--task=sales-hourly --execute/);
  assert.match(
    scheduled,
    /if \(task === 'sales-hourly'\)[\s\S]*?sync_full_managed_sales\.mjs/,
  );
  assert.match(sales, /new SheinOpenApiClient\(/);

  assert.match(supplyUnit, /--task=supply-daily --execute/);
  assert.match(
    coordinator,
    /if \(task === COORDINATOR_TASKS\.SUPPLY\)[\s\S]*?sync_full_managed_supply\.mjs/,
  );
  assert.match(supply, /new SheinOpenApiClient\(options\)/);

  assert.match(financeDailyUnit, /--task=finance-daily --execute/);
  assert.match(
    coordinator,
    /if \(task === COORDINATOR_TASKS\.FINANCE\)[\s\S]*?sync_full_managed_home_finance\.mjs/,
  );
  assert.match(
    financeBackfillUnit,
    /scripts\/sync_full_managed_home_finance\.mjs[\s\S]*--execute/,
  );
  assert.match(finance, /new SheinOpenApiClient\(/);

  assert.match(realtimeUnit, /--task=realtime-cockpit --execute/);
  assert.match(
    coordinator,
    /if \(task === COORDINATOR_TASKS\.REALTIME\)[\s\S]*?sync_full_managed_sales\.mjs/,
  );

  assert.match(
    purchaseBackfillUnit,
    /scripts\/backfill_full_managed_purchase_order_history\.mjs[\s\S]*--execute/,
  );
  assert.match(purchaseBackfill, /createBackfillExecuteRuntime\(\{ plan \}\)/);
  assert.match(backfillRuntime, /loadSupplySyncModule\(\)/);
  assert.match(backfillRuntime, /runSupplySync/);

  assert.match(hydrationUnit, /scripts\/run_full_managed_webhook_hydration\.mjs/);
  assert.match(
    hydration,
    /import \{ runSupplySync \} from '\.\/sync_full_managed_supply\.mjs';/,
  );
});

test('host-role documentation fixes fnOS fail-closed and cloud compatibility values', async () => {
  const [example, readme, deployment, runbook] = await Promise.all([
    text('infra/systemd/shein-fm-openapi-proxy.env.example'),
    text('README.md'),
    text('docs/cloud-deployment.md'),
    text('docs/runbooks/fnos-cutover.md'),
  ]);

  assert.match(example, /^SHEIN_FM_OPENAPI_PROXY_URL=http:\/\/127\.0\.0\.1:18080$/m);
  assert.match(example, /^SHEIN_FM_OPENAPI_PROXY_REQUIRED=1$/m);
  assert.match(example, /root-owned and mode 0600/);

  for (const unit of OPENAPI_UNITS) {
    assert.ok(deployment.includes(`\`${unit}\``), `deployment docs omit ${unit}`);
  }
  assert.ok(deployment.includes(PROXY_ENV_DIRECTIVE));
  assert.match(deployment, /SHEIN_FM_OPENAPI_PROXY_URL=\r?\nSHEIN_FM_OPENAPI_PROXY_REQUIRED=0/);
  assert.match(deployment, /root:root 0600/);
  assert.match(deployment, /迁移期间注入七个密码/);
  assert.match(deployment, /SHEIN_FM_WEBAPI_LOGIN_DB_PASSWORD/);
  assert.match(deployment, /sheinfm_webapi_loader/);

  for (const document of [readme, deployment, runbook]) {
    assert.match(document, /HTTP_PROXY/);
    assert.match(document, /HTTPS_PROXY/);
    assert.match(document, /ALL_PROXY/);
  }
  assert.match(readme, /\/etc\/nginx\/shein-fm-upstreams\.conf/);
  assert.match(readme, /Authorization Broker[\s\S]*127\.0\.0\.1:8789/);
  assert.match(deployment, /cloud upstream 模板/);
  assert.match(deployment, /fnOS upstream 切换前必须同时满足/);
  assert.match(deployment, /恢复到 `\/etc\/nginx\/shein-fm-upstreams\.conf`/);
  assert.match(runbook, /missing or failed[\s\S]*fail the official OpenAPI request/);
});
