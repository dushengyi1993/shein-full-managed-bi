import test from 'node:test';
import assert from 'node:assert/strict';
import { handoverWebhookGuard } from '../../scripts/lib/fnos-webhook-guard-handover.mjs';
import { captureFreezeBaseline, REQUIRED_WEBHOOK_UNITS } from '../../scripts/lib/fnos-webhook-freeze-continuity.mjs';

const order = ['readOld', 'readSource', 'startNew', 'readNew', 'stopOld', 'readOld', 'readSource', 'readNew'];
function fixture({ failAt = -1, transform = (_name, _index, value) => value } = {}) {
  const calls = [];
  const units = Object.fromEntries(REQUIRED_WEBHOOK_UNITS.map((Id) => [Id, {
    Id, LoadState: 'loaded', ActiveState: 'inactive',
    ActiveEnterTimestampMonotonic: '10', InactiveEnterTimestampMonotonic: '20',
    ...(Id.endsWith('.service') ? { MainPID: '0', InvocationID: 'a'.repeat(32) } : {}),
  }]));
  let stopped = false;
  const call = (name, action) => async () => {
    const index = calls.length;
    calls.push(name);
    if (index === failAt) throw new Error('secret-upstream-payload');
    return transform(name, index, await action());
  };
  const args = {
    sourceFreezeBaseline: captureFreezeBaseline(units),
    oldGuardName: 'old.service', newGuardName: 'new.service', oldGuardInvocationId: 'b'.repeat(32),
    readOldGuard: call('readOld', () => ({ Id: 'old.service', LoadState: 'loaded',
      ActiveState: stopped ? 'inactive' : 'active', MainPID: stopped ? '0' : '20', InvocationID: 'b'.repeat(32) })),
    readSourceUnits: call('readSource', () => structuredClone(units)),
    startNewGuard: call('startNew', () => undefined),
    readNewGuard: call('readNew', () => ({ Id: 'new.service', LoadState: 'loaded',
      ActiveState: 'active', MainPID: '30', InvocationID: 'c'.repeat(32) })),
    stopOldGuard: call('stopOld', () => { stopped = true; }),
  };
  return { args, calls };
}

test('handover executes exact sequence and returns evidence, never executes database writes', async () => {
  const f = fixture();
  const result = await handoverWebhookGuard(f.args);
  assert.deepEqual(f.calls, order);
  assert.equal(result.ok, true);
  assert.equal(result.replacement.invocationId, 'c'.repeat(32));
  assert.equal(result.completedPhases.length, 8);
});

for (let failAt = 0; failAt < order.length; failAt++) {
  test(`callback failure at ${failAt} prevents every later callback and hides original error`, async () => {
    const f = fixture({ failAt });
    await assert.rejects(handoverWebhookGuard(f.args), (e) => {
      assert.equal(e.code, 'WEBHOOK_GUARD_HANDOVER_FAILED');
      assert.equal(e.completedPhases.length, failAt);
      assert.doesNotMatch(e.message + JSON.stringify(e), /secret-upstream-payload/);
      return true;
    });
    assert.deepEqual(f.calls, order.slice(0, failAt + 1));
  });
}

const invalidCases = [
  ['old missing before handover', 0, () => null],
  ['old invocation changed', 0, (v) => ({ ...v, InvocationID: 'd'.repeat(32) })],
  ['new reuses old invocation', 3, (v) => ({ ...v, InvocationID: 'b'.repeat(32) })],
  ['old garbage-collected after stop', 5, (v) => ({ ...v, LoadState: 'not-found' })],
  ['old still active after stop', 5, (v) => ({ ...v, ActiveState: 'active', MainPID: '20' })],
  ['source restarted and stopped again', 6, (v) => {
    v['shein-fm-webhook-worker.service'].InactiveEnterTimestampMonotonic = '25'; return v;
  }],
  ['replacement no longer active', 7, (v) => ({ ...v, ActiveState: 'inactive', MainPID: '0' })],
  ['replacement was restarted', 7, (v) => ({ ...v, InvocationID: 'd'.repeat(32) })],
  ['replacement PID drift', 7, (v) => ({ ...v, MainPID: '31' })],
];
for (const [name, target, change] of invalidCases) {
  test(name, async () => {
    const f = fixture({ transform: (_name, index, value) => index === target ? change(value) : value });
    await assert.rejects(handoverWebhookGuard(f.args), { code: 'WEBHOOK_GUARD_HANDOVER_FAILED' });
    assert.deepEqual(f.calls, order.slice(0, target + 1));
  });
}
