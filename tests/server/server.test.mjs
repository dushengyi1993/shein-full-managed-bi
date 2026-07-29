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

  assert.equal(dashboard.schemaVersion, 4);
  assert.equal(dashboard.readOnly, true);
  assert.equal(dashboard.dataset.status, 'sample');
  assert.equal(dashboard.permission.totalStores, 24);
  assert.equal(dashboard.storeRanking.length, 24);
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

test('GET /api/procurement is a bounded read-only query surface', async () => {
  const response = await fetch(
    `${baseUrl}/api/procurement?page=1&pageSize=25&quick=ALL&sort=PRIORITY`,
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.readOnly, true);
  assert.equal(result.query.page, 1);
  assert.equal(result.query.pageSize, 25);
  assert.ok(Array.isArray(result.statusRows));
  assert.ok(Array.isArray(result.attention.rows));
  assert.equal(typeof result.source.materializedAttention.truncated, 'boolean');
});

test('procurement query rejects duplicates and mutation methods', async () => {
  const duplicate = await fetch(`${baseUrl}/api/procurement?q=a&q=b`);
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /QUERY_PARAMETER_DUPLICATED/);

  const mutation = await fetch(`${baseUrl}/api/procurement`, { method: 'POST' });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('allow'), 'GET, HEAD');
});

test('GET /api/sales is a bounded read-only query surface', async () => {
  const response = await fetch(
    `${baseUrl}/api/sales?owner=ALL&store=ALL&identity=ALL&momentum=ALL&sort=LAST30_DESC&productPage=1&standardPage=1&pageSize=25`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.readOnly, true);
  assert.ok(Array.isArray(payload.stores.rows));
  assert.ok(Array.isArray(payload.products.rows));
  assert.ok(Array.isArray(payload.standardProducts.rows));
  assert.equal(payload.products.pagination.pageSize, 25);
  assert.ok(payload.source.materializedRankings.storeSku);
});

test('sales query rejects duplicates and mutation methods', async () => {
  const duplicate = await fetch(`${baseUrl}/api/sales?q=a&q=b`);
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /QUERY_PARAMETER_DUPLICATED/);

  const mutation = await fetch(`${baseUrl}/api/sales`, { method: 'POST' });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('allow'), 'GET, HEAD');
});

test('GET /api/inventory is a bounded read-only query surface', async () => {
  const response = await fetch(
    `${baseUrl}/api/inventory?owner=ALL&store=ALL&quick=ALL&inventoryType=ALL`
    + '&inventorySort=PRIORITY&adviceSort=PRIORITY&inventoryPage=1&advicePage=1&pageSize=50',
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.readOnly, true);
  assert.equal(payload.query.pageSize, 50);
  assert.equal(payload.query.inventoryType, 'ALL');
  assert.ok(Array.isArray(payload.inventory.rows));
  assert.ok(Array.isArray(payload.advice.rows));
  assert.ok(Array.isArray(payload.inventory.storeSummaryRows));
  assert.ok(Array.isArray(payload.advice.storeSummaryRows));
  assert.equal(payload.inventory.pagination.pageSize, 50);
  assert.equal(payload.advice.pagination.pageSize, 50);
  assert.equal(typeof payload.inventory.source.truncated, 'boolean');
  assert.equal(typeof payload.advice.source.truncated, 'boolean');
  assert.equal(typeof payload.overview.matchedMaterializedInventoryRows, 'number');
  assert.ok(Object.hasOwn(payload.overview.shortage, 'knownCount'));
  assert.ok(Object.hasOwn(payload.overview.shortage, 'unknownCount'));
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const head = await fetch(`${baseUrl}/api/inventory`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('inventory query rejects duplicates, bad bounds and mutation methods', async () => {
  const duplicate = await fetch(`${baseUrl}/api/inventory?q=a&q=b`);
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /QUERY_PARAMETER_DUPLICATED/);

  const outOfRange = await fetch(`${baseUrl}/api/inventory?pageSize=101`);
  assert.equal(outOfRange.status, 400);
  assert.match(await outOfRange.text(), /QUERY_PARAMETER_OUT_OF_RANGE/);

  const unknownQuick = await fetch(`${baseUrl}/api/inventory?quick=DROP`);
  assert.equal(unknownQuick.status, 400);
  assert.match(await unknownQuick.text(), /QUERY_PARAMETER_INVALID/);

  const unknownStore = await fetch(`${baseUrl}/api/inventory?store=ZZ9999`);
  assert.equal(unknownStore.status, 400);
  assert.match(await unknownStore.text(), /QUERY_STORE_UNKNOWN/);

  const mutation = await fetch(`${baseUrl}/api/inventory`, { method: 'POST' });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('allow'), 'GET, HEAD');
});

test('GET /api/products is a bounded read-only identity query surface', async () => {
  const response = await fetch(
    `${baseUrl}/api/products?owner=ALL&store=ALL&quick=ALL&sort=IMPACT_DESC`
    + '&range=today&pendingPage=1&canonicalPage=1&pageSize=50',
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.readOnly, true);
  assert.equal(payload.query.pageSize, 50);
  assert.equal(payload.query.sort, 'IMPACT_DESC');
  assert.equal(payload.query.range, 'today');
  assert.ok(Array.isArray(payload.pending.rows));
  assert.ok(Array.isArray(payload.canonical.rows));
  // Independent pagination for the two lists.
  assert.equal(payload.pending.pagination.pageSize, 50);
  assert.equal(payload.canonical.pagination.pageSize, 50);
  assert.equal(typeof payload.pending.pagination.matchedMaterializedRows, 'number');
  assert.equal(typeof payload.canonical.pagination.matchedMaterializedRows, 'number');
  assert.equal(typeof payload.pending.source.truncated, 'boolean');
  assert.equal(typeof payload.canonical.source.truncated, 'boolean');
  // Two separate universes plus the aggregate pipeline are exposed.
  assert.ok(Object.hasOwn(payload.source.activeCatalogCoverage, 'confirmedSkus'));
  assert.ok(Object.hasOwn(payload.source.pipeline, 'status'));
  assert.ok(Object.hasOwn(payload.source.pipeline.evidence, 'sealedSetCount'));
  assert.ok(Object.hasOwn(payload.summary, 'matchedMaterializedPendingRows'));
  assert.ok(Object.hasOwn(payload.summary.pendingImpact, 'unknownCount'));
  assert.equal(response.headers.get('cache-control'), 'no-store');

  // No raw identity evidence, run id or fingerprint may reach the browser.
  const serialized = JSON.stringify(payload.source.pipeline);
  assert.doesNotMatch(serialized, /observationRunId|runId|fingerprint|payload|rawValue/i);

  const head = await fetch(`${baseUrl}/api/products`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('cache-control'), 'no-store');
});

test('product query rejects duplicates, bad bounds and mutation methods', async () => {
  const duplicate = await fetch(`${baseUrl}/api/products?q=a&q=b`);
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /QUERY_PARAMETER_DUPLICATED/);

  // Page size is a closed set: an arbitrary bounded number is still rejected.
  const badPageSize = await fetch(`${baseUrl}/api/products?pageSize=30`);
  assert.equal(badPageSize.status, 400);
  assert.match(await badPageSize.text(), /QUERY_PARAMETER_OUT_OF_RANGE/);

  const outOfRange = await fetch(`${baseUrl}/api/products?pendingPage=0`);
  assert.equal(outOfRange.status, 400);
  assert.match(await outOfRange.text(), /QUERY_PARAMETER_INVALID|QUERY_PARAMETER_OUT_OF_RANGE/);

  const unknownQuick = await fetch(`${baseUrl}/api/products?quick=DROP`);
  assert.equal(unknownQuick.status, 400);
  assert.match(await unknownQuick.text(), /QUERY_PARAMETER_INVALID/);

  const unknownSort = await fetch(`${baseUrl}/api/products?sort=DROP`);
  assert.equal(unknownSort.status, 400);
  assert.match(await unknownSort.text(), /QUERY_PARAMETER_INVALID/);

  const unknownStore = await fetch(`${baseUrl}/api/products?store=ZZ9999`);
  assert.equal(unknownStore.status, 400);
  assert.match(await unknownStore.text(), /QUERY_STORE_UNKNOWN/);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const mutation = await fetch(`${baseUrl}/api/products`, { method });
    assert.equal(mutation.status, 405, method);
    assert.equal(mutation.headers.get('allow'), 'GET, HEAD');
  }
});

test('GET /api/fulfilment is a bounded read-only delivery query surface', async () => {
  const response = await fetch(
    `${baseUrl}/api/fulfilment?owner=ALL&store=ALL&milestone=ALL&quick=ALL`
    + '&sort=PRIORITY&page=1&pageSize=50',
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.readOnly, true);
  assert.equal(payload.query.pageSize, 50);
  assert.equal(payload.query.milestone, 'ALL');
  assert.equal(payload.query.sort, 'PRIORITY');
  assert.ok(Array.isArray(payload.attention.rows));
  assert.ok(Array.isArray(payload.milestoneOverview));
  assert.equal(payload.attention.pagination.pageSize, 50);
  assert.equal(typeof payload.attention.source.truncated, 'boolean');
  // Delivery count and delivery quantity stay separate units.
  assert.ok(Object.hasOwn(payload.summary.snapshotDeliveryCount, 'unknownCount'));
  assert.ok(Object.hasOwn(payload.summary.snapshotDeliveryQuantity, 'unknownCount'));
  assert.ok(Object.hasOwn(payload.summary, 'expectedReceiptKnownCount'));
  // No funnel or completion rate is ever derived.
  assert.doesNotMatch(JSON.stringify(payload.summary), /rate|percent|conversion|funnel/i);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const head = await fetch(`${baseUrl}/api/fulfilment`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('cache-control'), 'no-store');
});

test('fulfilment query rejects duplicates, bad bounds and mutation methods', async () => {
  const duplicate = await fetch(`${baseUrl}/api/fulfilment?q=a&q=b`);
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /QUERY_PARAMETER_DUPLICATED/);

  // Page size is a closed set: an in-range number is still rejected.
  const badPageSize = await fetch(`${baseUrl}/api/fulfilment?pageSize=30`);
  assert.equal(badPageSize.status, 400);
  assert.match(await badPageSize.text(), /QUERY_PARAMETER_OUT_OF_RANGE/);

  const unknownQuick = await fetch(`${baseUrl}/api/fulfilment?quick=RECEIVED`);
  assert.equal(unknownQuick.status, 400);
  assert.match(await unknownQuick.text(), /QUERY_PARAMETER_INVALID/);

  const unknownSort = await fetch(`${baseUrl}/api/fulfilment?sort=DROP`);
  assert.equal(unknownSort.status, 400);
  assert.match(await unknownSort.text(), /QUERY_PARAMETER_INVALID/);

  const outOfRange = await fetch(`${baseUrl}/api/fulfilment?page=0`);
  assert.equal(outOfRange.status, 400);
  assert.match(await outOfRange.text(), /QUERY_PARAMETER_INVALID|QUERY_PARAMETER_OUT_OF_RANGE/);

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const mutation = await fetch(`${baseUrl}/api/fulfilment`, { method });
    assert.equal(mutation.status, 405, method);
    assert.equal(mutation.headers.get('allow'), 'GET, HEAD');
  }
});

test('procurement exposes exact page sizes, explicit quick filters and a compact status summary', async () => {
  const response = await fetch(`${baseUrl}/api/procurement?pageSize=100&quick=DEFECTIVE`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.query.pageSize, 100);
  assert.equal(payload.query.quick, 'DEFECTIVE');
  assert.deepEqual(payload.filters.pageSizes, [25, 50, 100]);
  assert.deepEqual(payload.filters.quick, [
    'ALL', 'HIGH', 'OVERDUE', 'PENDING_DELIVERY',
    'PENDING_RECEIPT', 'PENDING_STORAGE', 'DEFECTIVE',
  ]);
  // The compact overview is one row per status, never one row per store.
  assert.ok(Array.isArray(payload.statusOverview));
  assert.ok(payload.statusOverview.length <= payload.statusRows.length);
  assert.ok(Object.hasOwn(payload.summary.quantityStages, 'defective'));
  assert.match(payload.summary.attentionScopeLabel, /不是转化漏斗/);
  assert.doesNotMatch(JSON.stringify(payload.summary), /rate|percent|conversion|funnel/i);

  const badPageSize = await fetch(`${baseUrl}/api/procurement?pageSize=2`);
  assert.equal(badPageSize.status, 400);
  assert.match(await badPageSize.text(), /QUERY_PARAMETER_OUT_OF_RANGE/);
});

test('GET /api/events opens a no-buffer read-only SSE stream', async () => {
  const result = await new Promise((resolve, reject) => {
    const clientRequest = request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/events',
        headers: { Accept: 'text/event-stream' },
      },
      (response) => {
        response.setEncoding('utf8');
        response.once('data', (chunk) => {
          resolve({
            status: response.statusCode,
            contentType: response.headers['content-type'],
            buffering: response.headers['x-accel-buffering'],
            chunk,
          });
          clientRequest.destroy();
          response.destroy();
        });
      },
    );
    clientRequest.once('error', (error) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    clientRequest.end();
  });
  assert.equal(result.status, 200);
  assert.match(result.contentType, /^text\/event-stream/);
  assert.equal(result.buffering, 'no');
  assert.match(result.chunk, /retry: 5000|event: ready/);
});

test('server shutdown ends owned SSE subscribers before draining HTTP', async () => {
  const streamServer = createDashboardServer({
    dataFile: fixture,
    updatePollIntervalMs: 20,
    updateHeartbeatIntervalMs: 30,
  });
  await new Promise((resolve, reject) => {
    streamServer.once('error', reject);
    streamServer.listen(0, '127.0.0.1', resolve);
  });
  const address = streamServer.address();
  let responseEnded = false;
  const clientRequest = request({
    host: '127.0.0.1',
    port: address.port,
    method: 'GET',
    path: '/api/events',
  });
  const opened = new Promise((resolve, reject) => {
    clientRequest.once('error', reject);
    clientRequest.once('response', (response) => {
      response.setEncoding('utf8');
      response.once('data', resolve);
      response.once('end', () => { responseEnded = true; });
      response.once('close', () => { responseEnded = true; });
    });
  });
  clientRequest.end();
  await opened;
  await Promise.race([
    new Promise((resolve, reject) => {
      streamServer.close((error) => (error ? reject(error) : resolve()));
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('server close did not drain SSE')), 1_000);
    }),
  ]);
  for (let attempt = 0; attempt < 10 && !responseEnded; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  clientRequest.destroy();
  assert.equal(responseEnded, true);
});

test('serves the local dashboard and its static assets', async () => {
  const [pageResponse, scriptResponse, styleResponse, parityStyleResponse, faviconResponse] = await Promise.all([
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/app.js`),
    fetch(`${baseUrl}/styles.css`),
    fetch(`${baseUrl}/home-parity.css`),
    fetch(`${baseUrl}/favicon.svg`),
  ]);

  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /^text\/html/);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /全托运营驾驶舱/);
  assert.match(pageHtml, /\/app\.js\?v=20260729\.8/);
  assert.match(pageHtml, /\/styles\.css\?v=20260729\.8/);
  assert.match(pageHtml, /\/home-parity\.css\?v=20260729\.8/);

  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get('content-type'), /^text\/javascript/);
  assert.match(await scriptResponse.text(), /\/api\/dashboard/);

  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get('content-type'), /^text\/css/);

  assert.equal(parityStyleResponse.status, 200);
  assert.match(parityStyleResponse.headers.get('content-type'), /^text\/css/);

  assert.equal(faviconResponse.status, 200);
  assert.match(faviconResponse.headers.get('content-type'), /^image\/svg\+xml/);
});

test('static UI excludes consumer commerce metrics while allowing SHEIN purchase-order counts', async () => {
  const files = ['index.html', 'app.js', 'styles.css', 'home-parity.css'];
  const contents = await Promise.all(
    files.map((name) => readFile(new URL(`../../src/web/${name}`, import.meta.url), 'utf8')),
  );
  const source = contents.join('\n');
  assert.doesNotMatch(
    source,
    /data-metric=["'](?:revenue|profit|gmv|consumerOrderCount|consumerReturnCount)["']/i,
  );
  assert.doesNotMatch(
    source,
    /\.(?:revenue|profit|gmv|consumerOrderCount|consumerReturnCount)\b/i,
  );
  assert.match(source, /purchaseOrderStatus/);
  assert.match(source, /\.orderCount\b/);
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
