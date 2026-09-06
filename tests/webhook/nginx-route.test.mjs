import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { WEBHOOK_CALLBACK_PATH } from '../../src/webhook/crypto.mjs';

const NGINX_CONFIG = new URL('../../infra/nginx/shein-fm.conf', import.meta.url);
const NGINX_LOGROTATE = new URL(
  '../../infra/logrotate/shein-fm-webhook',
  import.meta.url,
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactLocationBlock(config, locationPath, modifier = '=') {
  const marker = `location ${modifier} ${locationPath} {`;
  const markerIndex = config.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing exact Nginx location ${locationPath}`);
  assert.equal(
    config.indexOf(marker, markerIndex + marker.length),
    -1,
    `exact Nginx location ${locationPath} must occur once`,
  );
  const open = markerIndex + marker.length - 1;
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

test('Nginx applies host-scoped HSTS without descendant or preload scope', async () => {
  const config = await readFile(NGINX_CONFIG, 'utf8');
  const directives = [
    ...config.matchAll(
      /add_header\s+Strict-Transport-Security\s+"([^"]+)"\s+always;/gi,
    ),
  ];

  assert.match(config, /\bserver_name fm\.dushengyi\.cc;/);
  assert.equal(directives.length, 1, 'HSTS must be emitted exactly once');
  assert.equal(directives[0][1], 'max-age=31536000');
  assert.doesNotMatch(directives[0][1], /includeSubDomains|preload/i);
});

test('Nginx compresses large homepage JSON responses without enabling proxy caching', async () => {
  const config = await readFile(NGINX_CONFIG, 'utf8');

  assert.match(config, /\bgzip_vary on;/);
  assert.match(config, /\bgzip_min_length 1024;/);
  assert.match(config, /\bgzip_comp_level 5;/);
  assert.match(config, /\bgzip_types [^;]*application\/json[^;]*;/);
  assert.doesNotMatch(config, /\bproxy_cache(?:_path|_key|_valid|_bypass|_use_stale)?\b/);
});

test('Nginx exposes the receiver callback path instead of sending it to the BI portal', async () => {
  assert.equal(WEBHOOK_CALLBACK_PATH, '/api/shein/webhook/v1/events');
  const config = await readFile(NGINX_CONFIG, 'utf8');
  const block = exactLocationBlock(config, WEBHOOK_CALLBACK_PATH);

  assert.match(config, /include \/etc\/nginx\/shein-fm-upstreams\.conf;/);
  assert.equal(
    config.match(/include \/etc\/nginx\/shein-fm-upstreams\.conf;/g)?.length,
    1,
    'the stable upstream include must occur exactly once',
  );
  assert.match(block, /proxy_pass http:\/\/shein_fm_webhook;/);
  assert.doesNotMatch(block, /127\.0\.0\.1:8788/);
  assert.ok(
    config.indexOf(`location = ${WEBHOOK_CALLBACK_PATH}`)
      < config.indexOf('location / {'),
    'the exact webhook route must precede the portal fallback',
  );
  assert.match(config, /location \/ \{[\s\S]*?proxy_pass http:\/\/shein_fm_portal;/);
  assert.doesNotMatch(
    config,
    /proxy_pass http:\/\/127\.0\.0\.1:(?:8788|8793|8794)\b/,
    'Portal, Webhook, and Store Login must use the environment-owned named upstreams',
  );
  for (const [path, modifier] of [
    ['/openapi/authorize/callback', '='],
    ['/authorize', '='],
    ['/authorize/', '^~'],
  ]) {
    const authorization = exactLocationBlock(config, path, modifier);
    assert.deepEqual(
      [...authorization.matchAll(/\bproxy_pass\s+([^;]+);/g)].map((match) => match[1]),
      ['http://127.0.0.1:18789'],
      `${path} must use only the dedicated loopback VM authorization tunnel, not a business upstream`,
    );
    assert.match(authorization, /limit_req_status 429;/);
    assert.match(authorization, /limit_req zone=shein_fm_auth_(?:callback|web) burst=\d+ nodelay;/);
    assert.match(authorization, /error_log \/dev\/null crit;/);
    assert.match(authorization, /access_log \/var\/log\/nginx\/shein-fm-auth-security\.log shein_fm_auth_safe;/);
    assert.match(authorization, /proxy_set_header Host \$host;/);
    assert.ok(config.indexOf(`location ${modifier} ${path} {`) < config.indexOf('location / {'));
  }
  assert.doesNotMatch(config, /proxy_pass http:\/\/127\.0\.0\.1:8789;/);
});

test('Webhook Nginx route bounds ingress and forwards only receiver headers', async () => {
  const config = await readFile(NGINX_CONFIG, 'utf8');
  const block = exactLocationBlock(config, WEBHOOK_CALLBACK_PATH);

  assert.match(config, /limit_req_zone \$binary_remote_addr zone=shein_fm_webhook_ingress:1m rate=20r\/s;/);
  assert.match(config, /limit_conn_zone \$binary_remote_addr zone=shein_fm_webhook_connections:1m;/);
  assert.match(block, /client_max_body_size 1m;/);
  assert.match(block, /client_body_timeout 5s;/);
  assert.match(block, /limit_req zone=shein_fm_webhook_ingress burst=80 nodelay;/);
  assert.match(block, /limit_conn shein_fm_webhook_connections 20;/);
  assert.match(block, /proxy_connect_timeout 1s;/);
  assert.match(block, /proxy_send_timeout 2s;/);
  assert.match(block, /proxy_read_timeout 2s;/);
  assert.match(block, /proxy_pass_request_headers off;/);
  for (const header of [
    'X-Lt-Appid',
    'X-Lt-Openkeyid',
    'X-Lt-Eventcode',
    'X-Lt-Timestamp',
    'X-Lt-Signature',
  ]) {
    assert.match(block, new RegExp(`proxy_set_header ${escapeRegExp(header)} `));
  }
  assert.doesNotMatch(block, /proxy_set_header (?:Authorization|Cookie)\b/i);
});

test('Webhook security logs exclude query strings, bodies and sensitive headers', async () => {
  const config = await readFile(NGINX_CONFIG, 'utf8');
  const block = exactLocationBlock(config, WEBHOOK_CALLBACK_PATH);
  const logFormat = /log_format shein_fm_webhook_safe\s+([\s\S]*?);/.exec(config)?.[1] ?? '';

  assert.match(block, /access_log \/var\/log\/nginx\/shein-fm-webhook-access\.log shein_fm_webhook_safe;/);
  assert.match(block, /error_log \/var\/log\/nginx\/shein-fm-webhook-error\.log crit;/);
  assert.match(logFormat, /\$uri/);
  assert.doesNotMatch(
    logFormat,
    /\$(?:request\b|request_uri\b|args\b|query_string\b|request_body\b|http_[a-z0-9_]+)/i,
  );
  assert.doesNotMatch(logFormat, /signature|openkey|appid|eventdata|authorization|cookie/i);
});

test('Webhook ingress logs have a bounded rotation policy', async () => {
  const policy = await readFile(NGINX_LOGROTATE, 'utf8');

  assert.match(policy, /\/var\/log\/nginx\/shein-fm-webhook-access\.log/);
  assert.match(policy, /\/var\/log\/nginx\/shein-fm-webhook-error\.log/);
  assert.match(policy, /\bdaily\b/);
  assert.match(policy, /\brotate 14\b/);
  assert.match(policy, /\bsize 20M\b/);
  assert.match(policy, /\bcompress\b/);
  assert.match(policy, /\bcreate 0640 www-data adm\b/);
  assert.match(policy, /kill -USR1/);
});
