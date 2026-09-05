import {
  assertFreezeContinuity,
  assertOldGuardHandoverStopped,
  validateGuardUnit,
} from './fnos-webhook-freeze-continuity.mjs';

// All effects are supplied by the production owner. A stopped transient unit
// may be garbage-collected: callers must retain a queryable unit definition.
// Missing units deliberately fail closed. This function never executes a plan
// or restores services; the caller owns recovery after every failure.
export async function handoverWebhookGuard({
  sourceFreezeBaseline, oldGuardName, oldGuardInvocationId, newGuardName,
  readOldGuard, readSourceUnits, startNewGuard, readNewGuard, stopOldGuard,
}) {
  let phase = 'INPUT';
  const completedPhases = [];
  const step = async (name, action) => {
    phase = name;
    const result = await action();
    completedPhases.push(name);
    return result;
  };
  try {
    if (![readOldGuard, readSourceUnits, startNewGuard, readNewGuard, stopOldGuard]
      .every((fn) => typeof fn === 'function')
      || !/^[0-9a-f]{32}$/.test(oldGuardInvocationId ?? '')
      || typeof oldGuardName !== 'string' || typeof newGuardName !== 'string'
      || oldGuardName === newGuardName) throw new Error();
    await step('OLD_ACTIVE', async () => {
      const old = validateGuardUnit(await readOldGuard(), { expectedGuardName: oldGuardName });
      if (old.invocationId !== oldGuardInvocationId) throw new Error();
    });
    await step('SOURCE_BEFORE', async () =>
      assertFreezeContinuity(sourceFreezeBaseline, await readSourceUnits()));
    await step('NEW_START', startNewGuard);
    const replacement = await step('NEW_ACTIVE', async () =>
      validateGuardUnit(await readNewGuard(), {
        expectedGuardName: newGuardName, previousGuardInvocationId: oldGuardInvocationId,
      }));
    await step('OLD_STOP', stopOldGuard);
    await step('OLD_STOPPED', async () =>
      assertOldGuardHandoverStopped(await readOldGuard(), { expectedOldGuardName: oldGuardName }));
    await step('SOURCE_AFTER', async () =>
      assertFreezeContinuity(sourceFreezeBaseline, await readSourceUnits()));
    await step('NEW_RECHECK', async () => {
      const current = validateGuardUnit(await readNewGuard(), {
        expectedGuardName: newGuardName, previousGuardInvocationId: oldGuardInvocationId,
      });
      if (current.invocationId !== replacement.invocationId
        || current.mainPid !== replacement.mainPid) throw new Error();
    });
    return Object.freeze({
      ok: true, freezeFingerprint: sourceFreezeBaseline.freezeFingerprint,
      replacement, completedPhases: Object.freeze([...completedPhases]),
    });
  } catch {
    const error = new Error('Webhook guard handover failed; production recovery requires current-state checks');
    error.code = 'WEBHOOK_GUARD_HANDOVER_FAILED';
    error.phase = phase;
    error.completedPhases = Object.freeze([...completedPhases]);
    throw error;
  }
}
