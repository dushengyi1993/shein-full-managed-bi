import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, projectRoot), 'utf8');
}

function functionBody(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

test('system workspace consumes only the independent sanitized system endpoint', async () => {
  const app = await read('src/web/app.js');
  const url = functionBody(app, 'systemQueryUrl');
  const load = functionBody(app, 'loadSystem');
  const render = functionBody(app, 'renderSystem');

  assert.match(url, /\/api\/system/);
  assert.match(url, /owner: state\.owner/);
  assert.match(url, /store: state\.store/);
  assert.match(url, /q: state\.query/);
  assert.match(load, /requestSerial !== state\.system\.requestSerial/);
  assert.match(load, /result\.readOnly !== true/);
  assert.match(load, /Array\.isArray\(result\.issues\?\.rows\)/);
  assert.match(load, /Array\.isArray\(result\.profiles\?\.rows\)/);
  assert.match(render, /systemQueryState\('loading'\)/);
  assert.match(render, /systemQueryState\('error'\)/);
  assert.doesNotMatch(render, /state\.data\?\.system|supplyDomain\(\)|platformDomain\(\)/);
});

test('system workspace puts actionable evidence before technical boundaries', async () => {
  const app = await read('src/web/app.js');
  const render = functionBody(app, 'renderSystem');
  const order = [
    'systemDecisionOverview(queryData)',
    'systemIssueTable(queryData)',
    'systemProfileTable(queryData)',
    'systemServiceTable(queryData)',
    'systemCoverageTable(queryData)',
    'systemBoundaryDisclosure(queryData)',
  ].map((token) => render.indexOf(token));

  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  assert.match(render, /重新读取运行态/);
  assert.match(render, /不执行 systemd、登录或同步任务/);
});

test('Profile table separates onboarding registration from last renewal proof', async () => {
  const app = await read('src/web/app.js');
  const table = functionBody(app, 'systemProfileTable');
  const reason = functionBody(app, 'systemSessionReason');

  assert.match(table, /登录登记/);
  assert.match(table, /最近续期验真/);
  assert.match(table, /已登记.*不等于当前登录态仍有效/);
  assert.match(table, /row\.actionRequired/);
  assert.match(reason, /WEBAPI_SESSION_AUTH_EXPIRED/);
  assert.match(reason, /最近一次续期验真通过/);
  assert.match(table, /systemSessionReason\(row\)/);
  assert.match(table, /systemLoginMaintenanceAction\(row\)/);
  assert.doesNotMatch(table, /row\.(cookie|password|token|authorization)/i);
});

test('system task timing distinguishes interval timers from an absent schedule', async () => {
  const app = await read('src/web/app.js');
  const nextRun = functionBody(app, 'systemNextRunLabel');
  const table = functionBody(app, 'systemServiceTable');

  assert.match(nextRun, /row\.timerState === 'active'/);
  assert.match(nextRun, /按间隔运行/);
  assert.match(nextRun, /尚无计划时间/);
  assert.match(table, /systemNextRunLabel\(row\)/);
});

test('system drilldowns preserve the selected owner or store scope', async () => {
  const app = await read('src/web/app.js');
  const href = functionBody(app, 'systemRouteHref');
  const issues = functionBody(app, 'systemIssueTable');
  const services = functionBody(app, 'systemServiceTable');

  assert.match(href, /owner: state\.owner/);
  assert.match(href, /store: state\.store/);
  assert.match(href, /serializeHashState/);
  assert.match(issues, /systemRouteHref\(row\.href\)/);
  assert.match(services, /systemRouteHref\(row\.route\)/);
});

test('system runtime UI remains dense, responsive and colour is not the only status signal', async () => {
  const styles = await read('src/web/styles.css');

  assert.match(styles, /\.system-issue-table\s*\{[^}]*min-width:\s*980px/s);
  assert.match(styles, /\.system-profile-table\s*\{[^}]*min-width:\s*1160px/s);
  assert.match(styles, /\.system-login-button\s*\{[^}]*cursor:\s*pointer/s);
  assert.match(styles, /\.system-store-list span,[\s\S]*border:/);
  assert.match(styles, /\.system-decision-text\.attention/);
  assert.match(styles, /\.system-decision-text\.healthy/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.system-boundary-grid[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.system-workspace-actions[\s\S]*flex-direction:\s*column/);
});

test('system runtime is materialized on a bounded timer and exposed read-only to the portal', async () => {
  const timer = await read('infra/systemd/shein-fm-system-health.timer');
  const portal = await read('infra/systemd/shein-fm-portal.service');

  assert.match(timer, /OnUnitInactiveSec=5min/);
  assert.match(timer, /Persistent=true/);
  assert.match(portal, /FULL_BI_SYSTEM_HEALTH_FILE=\/srv\/shein-fm\/runtime\/dashboard\/system-health\.json/);
  assert.match(portal, /ReadOnlyPaths=\/srv\/shein-fm\/runtime\/dashboard\/system-health\.json/);
});
