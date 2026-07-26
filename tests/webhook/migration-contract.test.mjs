import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MIGRATION = new URL('../../db/migrations/0005_webhook_runtime.sql', import.meta.url);
const VERIFY = new URL('../../db/verify/0005_webhook_runtime.sql', import.meta.url);

test('webhook migration keeps ciphertext receipts separate from jobs and safe events', async () => {
  const sql = await readFile(MIGRATION, 'utf8');
  for (const relation of [
    'raw.webhook_receipt',
    'ops.webhook_runtime_heartbeat',
    'ops.webhook_job',
    'ops.operational_event',
    'ops.webhook_hydration_directive',
    'ops.webhook_subscription_state',
    'ops.webhook_store_gate',
  ]) {
    assert.match(sql, new RegExp(relation.replace('.', '\\.')));
  }
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /max_attempts integer NOT NULL DEFAULT 8/);
  assert.match(sql, /reopen_webhook_authorization_gate_after_probe/);
  assert.match(sql, /probe\.outcome = 'GRANTED'/);
  assert.match(sql, /probe\.probed_at > gate_blocked_at/);
  assert.match(sql, /guard_webhook_store_gate_recovery/);
  assert.match(sql, /trg_ops_webhook_runtime_heartbeat_append_only/);
  assert.match(sql, /Schema presence and an empty queue are not runtime-health evidence/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC/);
  assert.doesNotMatch(sql, /\bdecrypted_payload\b|\bplaintext\b|\bapp_id\b|\bopen_key_id\b/i);
});

test('verification script checks immutable receipts, queue index and probe recovery', async () => {
  const sql = await readFile(VERIFY, 'utf8');
  assert.match(sql, /trg_raw_webhook_receipt_immutable/);
  assert.match(sql, /ix_ops_webhook_job_ready/);
  assert.match(sql, /uq_ops_webhook_job_receipt/);
  assert.match(sql, /reopen_webhook_authorization_gate_after_probe/);
  assert.match(sql, /trg_ops_webhook_store_gate_recovery/);
  assert.match(sql, /trg_ops_webhook_runtime_heartbeat_append_only/);
  assert.match(sql, /ix_ops_webhook_runtime_heartbeat_latest/);
  assert.match(sql, /executable by PUBLIC/);
});

test('systemd splits public ingress from the decrypting worker', async () => {
  const receiver = await readFile(
    new URL('../../infra/systemd/shein-fm-webhook-receiver.service', import.meta.url),
    'utf8',
  );
  const worker = await readFile(
    new URL('../../infra/systemd/shein-fm-webhook-worker.service', import.meta.url),
    'utf8',
  );
  assert.match(receiver, /serve_full_managed_webhook\.mjs/);
  assert.doesNotMatch(receiver, /run_full_managed_webhook_worker\.mjs/);
  assert.match(worker, /run_full_managed_webhook_worker\.mjs/);
  for (const unit of [receiver, worker]) {
    assert.match(unit, /FULL_BI_WEBHOOK_APPLICATION_FILE=.*application\.secret\.json/);
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /ProtectSystem=strict/);
  }
});

test('receiver never decrypts and worker never calls a real OpenAPI client', async () => {
  const receiver = await readFile(
    new URL('../../src/webhook/receiver.mjs', import.meta.url),
    'utf8',
  );
  const worker = await readFile(
    new URL('../../src/webhook/worker.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(receiver, /decryptFullManagedWebhookEvent|createDecipheriv/);
  assert.doesNotMatch(worker, /from ['"].*openapi|client\.request|fetch\(/i);
  assert.match(worker, /hydrationDirective/);
});
