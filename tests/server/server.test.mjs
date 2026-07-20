import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { createDashboardServer } from '../../src/server/app.mjs';

const fixture = fileURLToPath(new URL('../fixtures/dashboard.json', import.meta.url));
const webRoot = fileURLToPath(new URL('../../src/web/', import.meta.url));

let server;
let baseUrl;
let port;

before(async () => {
  server = createDashboardServer({ dataFile: fixture });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  port = address.port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('GET /health reports a read-only healthy service with security headers', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'shein-full-managed-bi',
    readOnly: true,
  });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('GET /ready verifies that the dashboard dataset is readable', async () => {
  const response = await fetch(`${baseUrl}/ready`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.service, 'shein-full-managed-bi');
  assert.equal(body.datasetStatus, 'sample');
});

test('GET /api/dashboard returns only the permitted volume dashboard shape', async () => {
  const response = await fetch(`${baseUrl}/api/dashboard`);
  assert.equal(response.status, 200);
  const dashboard = await response.json();

  assert.equal(dashboard.schemaVersion, 2);
  assert.equal(dashboard.readOnly, true);
  assert.equal(dashboard.dataset.status, 'sample');
  assert.equal(dashboard.permission.totalStores, 18);
  assert.equal(dashboard.storeRanking.length, 18);
  assert.equal(dashboard.skuRanking.length, 5);
  assert.equal(dashboard.readiness.length, 5);
  assert.equal(dashboard.salesTrend.length, 14);
  assert.deepEqual(Object.keys(dashboard.unitsSold), [
    'today',
    'yesterday',
    'last7Days',
    'last30Days',
  ]);

  assert.doesNotMatch(
    JSON.stringify(dashboard),
    /销售额|利润|订单数|revenue|profit|orderCount|order_count/i,
  );
});

test('serves the local dashboard and its static assets', async () => {
  const [pageResponse, scriptResponse, styleResponse, faviconResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/app.js`),
    fetch(`${baseUrl}/styles.css`),
    fetch(`${baseUrl}/favicon.svg`),
  ]);

  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /^text\/html/);
  assert.match(await pageResponse.text(), /全托运营驾驶舱/);

  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get('content-type'), /^text\/javascript/);
  assert.match(await scriptResponse.text(), /\/api\/dashboard/);

  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get('content-type'), /^text\/css/);

  assert.equal(faviconResponse.status, 200);
  assert.match(faviconResponse.headers.get('content-type'), /^image\/svg\+xml/);
});

test('static UI does not bind unsupported fields as live metrics', async () => {
  const files = ['index.html', 'app.js', 'styles.css'];
  const contents = await Promise.all(
    files.map((name) => readFile(new URL(`../../src/web/${name}`, import.meta.url), 'utf8')),
  );
  const source = contents.join('\n');
  assert.doesNotMatch(source, /data-metric=["'](?:revenue|profit|orderCount|order_count)["']/i);
  assert.doesNotMatch(source, /\.(?:revenue|profit|orderCount|order_count)\b/i);
});

test('rejects path traversal before reading static files', async () => {
  const result = await new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/%2e%2e%2fpackage.json',
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      },
    );
    clientRequest.once('error', reject);
    clientRequest.end();
  });

  assert.equal(result.status, 400);
  assert.match(result.body, /INVALID_PATH/);
  assert.doesNotMatch(result.body, /scripts|dependencies/);
});

test('rejects mutation methods', async () => {
  const response = await fetch(`${baseUrl}/api/dashboard`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.match(await response.text(), /METHOD_NOT_ALLOWED/);
});

test('does not expose auth endpoints when loopback development auth is disabled', async () => {
  const response = await fetch(`${baseUrl}/api/logout`, { method: 'POST' });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /NOT_FOUND/);
});

test('returns a generic error when the selected data file cannot be read', async () => {
  const unavailableServer = createDashboardServer({ dataFile: `${fixture}.missing` });
  await new Promise((resolve, reject) => {
    unavailableServer.once('error', reject);
    unavailableServer.listen(0, '127.0.0.1', resolve);
  });
  const address = unavailableServer.address();

  try {
    const [response, readiness] = await Promise.all([
      fetch(`http://127.0.0.1:${address.port}/api/dashboard`),
      fetch(`http://127.0.0.1:${address.port}/ready`),
    ]);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'DASHBOARD_DATA_UNAVAILABLE',
        message: '看板数据暂不可用',
      },
    });
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.json()).status, 'not_ready');
  } finally {
    await new Promise((resolve) => unavailableServer.close(resolve));
  }
});

test('unknown static files return a safe JSON 404', async () => {
  const response = await fetch(`${baseUrl}/does-not-exist.txt`);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /NOT_FOUND/);
});
