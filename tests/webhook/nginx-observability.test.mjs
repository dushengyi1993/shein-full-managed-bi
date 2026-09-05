import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WEBHOOK_CALLBACK_PATH } from '../../src/webhook/crypto.mjs';

const NGINX_CONFIG = new URL('../../infra/nginx/shein-fm.conf', import.meta.url);

function exactLocationBlock(config, locationPath) {
  const marker = `location = ${locationPath}`;
  const markerIndex = config.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing exact Nginx location ${locationPath}`);
  assert.equal(
    config.indexOf(marker, markerIndex + marker.length),
    -1,
    `exact Nginx location ${locationPath} must occur once`,
  );
  const open = config.indexOf('{', markerIndex + marker.length);
  assert.notEqual(open, -1, `location ${locationPath} has no opening brace`);
  let depth = 0;
  for (let index = open; index < config.length; index += 1) {
    if (config[index] === '{') depth += 1;
    if (config[index] === '}') {
      depth -= 1;
      if (depth === 0) return config.slice(markerIndex, index + 1);
    }
  }
  assert.fail(`location ${locationPath} has no closing brace`);
}

test('Webhook safe log format contains exact discriminator variables and preserves existing fields', async () => {
  const config = await readFile(NGINX_CONFIG, 'utf8');
  const match = /log_format shein_fm_webhook_safe\s+([\s\S]*?);/.exec(config);
  assert.ok(match, 'log_format shein_fm_webhook_safe must exist in nginx config');
  const logFormat = match[1];

  // 1. Preserve rejection discriminators and add only built-in timing fields.
  assert.match(logFormat, /upstream=\$upstream_status\s+limit_conn=\$limit_conn_status\s+limit_req=\$limit_req_status/);
  assert.match(logFormat, /connect_time=\$upstream_connect_time\s+header_time=\$upstream_header_time\s+response_time=\$upstream_response_time/);
  assert.deepEqual([...new Set(logFormat.match(/\$[a-z0-9_]+/g))].sort(), [
    '$remote_addr', '$time_iso8601', '$request_method', '$uri', '$status',
    '$request_time', '$request_length', '$upstream_status', '$limit_conn_status',
    '$limit_req_status', '$upstream_connect_time', '$upstream_header_time',
    '$upstream_response_time',
  ].sort(), 'Log fields must remain a closed allowlist');

  // 2. Existing baseline log fields must be preserved
  assert.match(logFormat, /\$remote_addr/);
  assert.match(logFormat, /\$time_iso8601/);
  assert.match(logFormat, /\$request_method/);
  assert.match(logFormat, /\$uri/);
  assert.match(logFormat, /\$status/);
  assert.match(logFormat, /\$request_time/);
  assert.match(logFormat, /\$request_length/);

  // 3. Sensitive / leaking variables must remain strictly excluded
  assert.doesNotMatch(
    logFormat,
    /\$(?:request\b|request_uri\b|args\b|query_string\b|request_body\b|http_[a-z0-9_]+)/i,
    'Sensitive request line, arguments, bodies, and arbitrary client headers must not be logged',
  );
  assert.doesNotMatch(
    logFormat,
    /signature|openkey|appid|eventdata|authorization|cookie|token|password/i,
    'Credentials and payload keys must not appear in log format',
  );
});

test('Nginx rate limits, connection limits, routes and proxies remain unchanged', async () => {
  const config = await readFile(NGINX_CONFIG, 'utf8');
  const block = exactLocationBlock(config, WEBHOOK_CALLBACK_PATH);

  // Rate limiting & connection limiting zones and parameters remain unchanged
  assert.match(config, /limit_req_zone \$binary_remote_addr zone=shein_fm_webhook_ingress:1m rate=20r\/s;/);
  assert.match(config, /limit_conn_zone \$binary_remote_addr zone=shein_fm_webhook_connections:1m;/);
  assert.match(block, /limit_req zone=shein_fm_webhook_ingress burst=80 nodelay;/);
  assert.match(block, /limit_req_status 429;/);
  assert.match(block, /limit_conn shein_fm_webhook_connections 20;/);

  // Proxy timeouts and pass targets remain unchanged
  assert.match(block, /proxy_pass http:\/\/shein_fm_webhook;/);
  assert.match(block, /proxy_http_version 1\.1;/);
  assert.match(block, /proxy_pass_request_headers off;/);
  assert.match(block, /proxy_connect_timeout 1s;/);
  assert.match(block, /proxy_send_timeout 2s;/);
  assert.match(block, /proxy_read_timeout 2s;/);
  assert.match(block, /client_max_body_size 1m;/);
  assert.match(block, /client_body_timeout 5s;/);

  // Access log path and error log level remain unchanged
  assert.match(block, /access_log \/var\/log\/nginx\/shein-fm-webhook-access\.log shein_fm_webhook_safe;/);
  assert.match(block, /error_log \/var\/log\/nginx\/shein-fm-webhook-error\.log crit;/);
});
