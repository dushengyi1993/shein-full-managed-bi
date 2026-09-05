import assert from "node:assert/strict";
import test from "node:test";

import {
  FreezeContinuityError,
  REQUIRED_WEBHOOK_UNITS,
  assertFreezeContinuity,
  assertOldGuardHandoverStopped,
  captureFreezeBaseline,
  validateGuardUnit,
  validateUnitShowRecord,
} from "../../scripts/lib/fnos-webhook-freeze-continuity.mjs";

function buildValidUnitMap({ timestampsOffset = 0, timerInvocationId = null, serviceZeroActiveMono = false } = {}) {
  const map = {};
  for (const name of REQUIRED_WEBHOOK_UNITS) {
    const isService = name.endsWith(".service");
    let activeMono = String(1000000 + timestampsOffset);
    if (isService && serviceZeroActiveMono && name === "shein-fm-webhook-hydration.service") {
      activeMono = "0"; // Valid in real schema when unit has never entered active state in current boot
    }
    map[name] = {
      Id: name,
      LoadState: "loaded",
      ActiveState: "inactive",
      ActiveEnterTimestampMonotonic: activeMono,
      InactiveEnterTimestampMonotonic: String(2000000 + timestampsOffset),
      ...(isService
        ? {
            MainPID: "0",
            InvocationID: "11112222333344445555666677778888",
          }
        : {
            ...(timerInvocationId ? { InvocationID: timerInvocationId } : {}),
          }),
    };
  }
  return map;
}

test("normal flow: capture freeze baseline with real schema (ActiveEnterTimestampMonotonic=0 for hydration.service), guard handover, and continuity", () => {
  const baselineMap = buildValidUnitMap({ serviceZeroActiveMono: true, timerInvocationId: "abcdefabcdefabcdefabcdefabcdef12" });
  const baseline = captureFreezeBaseline(baselineMap);

  assert.ok(baseline.freezeFingerprint);
  assert.equal(Object.keys(baseline.units).length, 5);
  assert.equal(baseline.units["shein-fm-webhook-hydration.service"].activeEnterTimestampMonotonic, "0");
  assert.equal(baseline.units["shein-fm-webhook-hydration.timer"].invocationId, "abcdefabcdefabcdefabcdefabcdef12");

  // 1. Old guard stopped
  const oldGuard = {
    Id: "shein-fm-webhook-dryrun-safety-20260905.service",
    LoadState: "loaded",
    ActiveState: "inactive",
    MainPID: "0",
  };
  assert.equal(
    assertOldGuardHandoverStopped(oldGuard, {
      expectedOldGuardName: "shein-fm-webhook-dryrun-safety-20260905.service",
    }),
    true
  );

  // 2. New guard active and running
  const newGuard = {
    Id: "shein-fm-webhook-execute-safety-20260905.service",
    LoadState: "loaded",
    ActiveState: "active",
    MainPID: "65432",
    InvocationID: "99998888777766665555444433332222",
  };
  const validatedGuard = validateGuardUnit(newGuard, {
    expectedGuardName: "shein-fm-webhook-execute-safety-20260905.service",
    previousGuardInvocationId: "11112222333344445555666677778888",
  });
  assert.equal(validatedGuard.activeState, "active");
  assert.equal(validatedGuard.mainPid, "65432");

  // 3. Continuity check succeeds
  assert.equal(assertFreezeContinuity(baseline, baselineMap), true);
});

test("old guard disappeared / missing / not-found cannot fake clean stop", () => {
  assert.throws(
    () =>
      assertOldGuardHandoverStopped(null, {
        expectedOldGuardName: "shein-fm-webhook-dryrun-safety-20260905.service",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_ABSENT"
  );

  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        {
          Id: "shein-fm-webhook-dryrun-safety-20260905.service",
          LoadState: "not-found",
          ActiveState: "inactive",
          MainPID: "0",
        },
        {
          expectedOldGuardName: "shein-fm-webhook-dryrun-safety-20260905.service",
        }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_NOT_LOADED"
  );

  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        {
          Id: "wrong-guard-name.service",
          LoadState: "loaded",
          ActiveState: "inactive",
          MainPID: "0",
        },
        {
          expectedOldGuardName: "shein-fm-webhook-dryrun-safety-20260905.service",
        }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_NAME_MISMATCH"
  );
});

test("old guard still live or MainPID > 0 fails closed", () => {
  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        {
          Id: "shein-fm-webhook-dryrun-safety-20260905.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "12345",
        },
        {
          expectedOldGuardName: "shein-fm-webhook-dryrun-safety-20260905.service",
        }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_STILL_ACTIVE"
  );

  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        {
          Id: "shein-fm-webhook-dryrun-safety-20260905.service",
          LoadState: "loaded",
          ActiveState: "inactive",
          MainPID: "9999", // lingering zombie PID
        },
        {
          expectedOldGuardName: "shein-fm-webhook-dryrun-safety-20260905.service",
        }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_STILL_RUNNING"
  );
});

test("source unit restarted and then stopped again is strictly rejected by continuity gate", () => {
  const baselineMap = buildValidUnitMap({ timestampsOffset: 0 });
  const baseline = captureFreezeBaseline(baselineMap);

  // Scenario A: Service restarted, got new InvocationID and new timestamps, then stopped again (PID=0, inactive)
  const restartedServiceMap = buildValidUnitMap({ timestampsOffset: 0 });
  restartedServiceMap["shein-fm-webhook-worker.service"].ActiveEnterTimestampMonotonic = "5000000";
  restartedServiceMap["shein-fm-webhook-worker.service"].InactiveEnterTimestampMonotonic = "6000000";
  restartedServiceMap["shein-fm-webhook-worker.service"].InvocationID = "abcdefabcdefabcdefabcdefabcdef12";

  assert.throws(
    () => assertFreezeContinuity(baseline, restartedServiceMap),
    (err) => err instanceof FreezeContinuityError && (err.code === "UNIT_LIFECYCLE_TIMESTAMP_DRIFT" || err.code === "UNIT_INVOCATION_DRIFT")
  );

  // Scenario B: Timer was re-armed and re-entered active/inactive (non-service unit timestamp drift)
  const rearmedTimerMap = buildValidUnitMap({ timestampsOffset: 0 });
  rearmedTimerMap["shein-fm-webhook-hydration.timer"].ActiveEnterTimestampMonotonic = "9999999";

  assert.throws(
    () => assertFreezeContinuity(baseline, rearmedTimerMap),
    (err) => err instanceof FreezeContinuityError && err.code === "UNIT_LIFECYCLE_TIMESTAMP_DRIFT"
  );
});

test("PID=0 false-pass prevention: non-zero PID or non-inactive state fails closed", () => {
  const map = buildValidUnitMap();
  map["shein-fm-webhook-worker.service"].MainPID = "58942"; // still running

  assert.throws(
    () => captureFreezeBaseline(map),
    (err) => err instanceof FreezeContinuityError && err.code === "SERVICE_PID_NOT_ZERO"
  );

  const activeMap = buildValidUnitMap();
  activeMap["shein-fm-webhook-hydration.service"].ActiveState = "active";

  assert.throws(
    () => captureFreezeBaseline(activeMap),
    (err) => err instanceof FreezeContinuityError && err.code === "ACTIVE_STATE_NOT_INACTIVE"
  );
});

test("guard validation strictly rejects unstarted guard, dead guard, PID<=0, missing/reused invocationId, name mismatch", () => {
  // Not active
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "shein-fm-webhook-execute-safety.service",
          LoadState: "loaded",
          ActiveState: "activating",
          MainPID: "1234",
          InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { expectedGuardName: "shein-fm-webhook-execute-safety.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_NOT_ACTIVE"
  );

  // MainPID 0 or negative
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "shein-fm-webhook-execute-safety.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "0",
          InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { expectedGuardName: "shein-fm-webhook-execute-safety.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_PID_INVALID"
  );

  // Reusing previous invocation ID
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "shein-fm-webhook-execute-safety.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "12345",
          InvocationID: "11112222333344445555666677778888",
        },
        {
          expectedGuardName: "shein-fm-webhook-execute-safety.service",
          previousGuardInvocationId: "11112222333344445555666677778888",
        }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_INVOCATION_REUSED"
  );

  // Name mismatch
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "wrong-name.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "12345",
          InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { expectedGuardName: "shein-fm-webhook-execute-safety.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_UNIT_NAME_MISMATCH"
  );
});

test("unit set completeness: missing unit, extra unit, or invalid field format fail closed", () => {
  const map = buildValidUnitMap();
  delete map["shein-fm-webhook-worker.service"];

  assert.throws(
    () => captureFreezeBaseline(map),
    (err) => err instanceof FreezeContinuityError && err.code === "REQUIRED_UNITS_SET_MISMATCH"
  );

  const extraMap = buildValidUnitMap();
  extraMap["unexpected.service"] = { Id: "unexpected.service", LoadState: "loaded", ActiveState: "inactive" };

  assert.throws(
    () => captureFreezeBaseline(extraMap),
    (err) => err instanceof FreezeContinuityError && err.code === "REQUIRED_UNITS_SET_MISMATCH"
  );

  // Non-service units do NOT require MainPID
  const timerRecord = {
    Id: "shein-fm-webhook-hydration.timer",
    LoadState: "loaded",
    ActiveState: "inactive",
    ActiveEnterTimestampMonotonic: "12345",
    InactiveEnterTimestampMonotonic: "67890",
  };
  const validatedTimer = validateUnitShowRecord("shein-fm-webhook-hydration.timer", timerRecord);
  assert.equal(validatedTimer.mainPid, null);
  assert.equal(validatedTimer.invocationId, null);

  // Corrupted timestamp
  assert.throws(
    () =>
      validateUnitShowRecord("shein-fm-webhook-hydration.timer", {
        ...timerRecord,
        ActiveEnterTimestampMonotonic: "not-a-number",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "TIMESTAMP_FORMAT_INVALID"
  );
});

test("LoadState enforcement: missing or non-loaded LoadState in oldGuard, newGuard, and units fails closed", () => {
  // Old guard missing LoadState or with arbitrary string
  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        { Id: "test-guard.service", ActiveState: "inactive", MainPID: "0" },
        { expectedOldGuardName: "test-guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_NOT_LOADED"
  );
  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        { Id: "test-guard.service", LoadState: "masked", ActiveState: "inactive", MainPID: "0" },
        { expectedOldGuardName: "test-guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_NOT_LOADED"
  );
  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        { Id: "test-guard.service", LoadState: "unknown-arbitrary-val", ActiveState: "inactive", MainPID: "0" },
        { expectedOldGuardName: "test-guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_NOT_LOADED"
  );

  // New guard missing or non-loaded LoadState
  assert.throws(
    () =>
      validateGuardUnit(
        { Id: "new-guard.service", ActiveState: "active", MainPID: "123", InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { expectedGuardName: "new-guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_NOT_LOADED"
  );
  assert.throws(
    () =>
      validateGuardUnit(
        { Id: "new-guard.service", LoadState: "not-found", ActiveState: "active", MainPID: "123", InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { expectedGuardName: "new-guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_NOT_LOADED"
  );

  // Unit show record missing or non-loaded LoadState
  assert.throws(
    () =>
      validateUnitShowRecord("shein-fm-webhook-worker.service", {
        Id: "shein-fm-webhook-worker.service",
        ActiveState: "inactive",
        ActiveEnterTimestampMonotonic: "1",
        InactiveEnterTimestampMonotonic: "2",
        MainPID: "0",
        InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "UNIT_LOAD_STATE_NOT_LOADED"
  );
});

test("PID SafeInteger bounds: rejects unsafe integers, Infinity, floats, and negative values", () => {
  // Service MainPID = unsafe large integer
  assert.throws(
    () =>
      validateUnitShowRecord("shein-fm-webhook-worker.service", {
        Id: "shein-fm-webhook-worker.service",
        LoadState: "loaded",
        ActiveState: "inactive",
        ActiveEnterTimestampMonotonic: "1",
        InactiveEnterTimestampMonotonic: "2",
        MainPID: "9007199254740993", // > Number.MAX_SAFE_INTEGER
        InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "PID_BOUND_INVALID"
  );

  // Guard MainPID = unsafe large integer
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "guard.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "9007199254740993",
          InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { expectedGuardName: "guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "PID_BOUND_INVALID"
  );

  // Guard MainPID = negative or decimal string
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "guard.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "-5",
          InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { expectedGuardName: "guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "PID_FORMAT_INVALID"
  );
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "guard.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "123.45",
          InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { expectedGuardName: "guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "PID_FORMAT_INVALID"
  );
});

test("missing InvocationID is explicitly tested and rejected on service and guard", () => {
  // Service missing InvocationID
  assert.throws(
    () =>
      validateUnitShowRecord("shein-fm-webhook-worker.service", {
        Id: "shein-fm-webhook-worker.service",
        LoadState: "loaded",
        ActiveState: "inactive",
        ActiveEnterTimestampMonotonic: "100",
        InactiveEnterTimestampMonotonic: "200",
        MainPID: "0",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "INVOCATION_ID_INVALID"
  );

  // Service with empty InvocationID
  assert.throws(
    () =>
      validateUnitShowRecord("shein-fm-webhook-worker.service", {
        Id: "shein-fm-webhook-worker.service",
        LoadState: "loaded",
        ActiveState: "inactive",
        ActiveEnterTimestampMonotonic: "100",
        InactiveEnterTimestampMonotonic: "200",
        MainPID: "0",
        InvocationID: "",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "INVOCATION_ID_INVALID"
  );

  // Guard missing InvocationID
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "guard.service",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "123",
        },
        { expectedGuardName: "guard.service" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_INVOCATION_INVALID"
  );

  // Non-service timer/path with invalid (non-32hex) InvocationID if present
  assert.throws(
    () =>
      validateUnitShowRecord("shein-fm-webhook-hydration.timer", {
        Id: "shein-fm-webhook-hydration.timer",
        LoadState: "loaded",
        ActiveState: "inactive",
        ActiveEnterTimestampMonotonic: "100",
        InactiveEnterTimestampMonotonic: "200",
        InvocationID: "invalid-not-32-hex",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "INVOCATION_ID_INVALID"
  );
});

test("timer and path InvocationID lifecycle: captured when present and triggers drift on change", () => {
  const map1 = buildValidUnitMap({ timerInvocationId: "11111111222222223333333344444444" });
  const baseline = captureFreezeBaseline(map1);
  assert.equal(baseline.units["shein-fm-webhook-hydration.timer"].invocationId, "11111111222222223333333344444444");

  // Timer InvocationID changes in live cloud
  const map2 = buildValidUnitMap({ timerInvocationId: "99999999888888887777777766666666" });
  assert.throws(
    () => assertFreezeContinuity(baseline, map2),
    (err) => err instanceof FreezeContinuityError && err.code === "UNIT_INVOCATION_DRIFT"
  );
});

test("baseline integrity validation: rejects corrupted baseline or invalid/incomplete units map", () => {
  const validMap = buildValidUnitMap();
  const baseline = captureFreezeBaseline(validMap);

  // Corrupted fingerprint inside baseline
  const tamperedBaseline = {
    ...baseline,
    freezeFingerprint: "0".repeat(64),
  };
  assert.throws(
    () => assertFreezeContinuity(tamperedBaseline, validMap),
    (err) => err instanceof FreezeContinuityError && err.code === "BASELINE_FINGERPRINT_CORRUPT"
  );

  // Missing unit inside baseline.units
  const incompleteUnits = { ...baseline.units };
  delete incompleteUnits["shein-fm-webhook-worker.service"];
  assert.throws(
    () => assertFreezeContinuity({ freezeFingerprint: "abc", units: incompleteUnits }, validMap),
    (err) => err instanceof FreezeContinuityError && err.code === "BASELINE_UNITS_INVALID"
  );

  // Null or non-plain-object member inside baseline.units
  const nullMemberUnits = { ...baseline.units, "shein-fm-webhook-worker.service": null };
  assert.throws(
    () => assertFreezeContinuity({ freezeFingerprint: "abc", units: nullMemberUnits }, validMap),
    (err) => err instanceof FreezeContinuityError && err.code === "BASELINE_UNITS_INVALID"
  );
});

test("secret sanitization: error messages never echo user input fields at any position", () => {
  const SECRET = "SUPER_SECRET_TOKEN_987654";

  // 1. Secret in unitName / Id
  assert.throws(
    () =>
      validateUnitShowRecord("unit-" + SECRET, {
        Id: "unit-" + SECRET,
        LoadState: "loaded",
        ActiveState: "active",
        ActiveEnterTimestampMonotonic: "10",
        InactiveEnterTimestampMonotonic: "20",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "ACTIVE_STATE_NOT_INACTIVE" && !err.message.includes(SECRET)
  );

  // 2. Secret in ActiveState
  assert.throws(
    () =>
      validateUnitShowRecord("shein-fm-webhook-worker.service", {
        Id: "shein-fm-webhook-worker.service",
        LoadState: "loaded",
        ActiveState: "active-" + SECRET,
        ActiveEnterTimestampMonotonic: "10",
        InactiveEnterTimestampMonotonic: "20",
        MainPID: "0",
        InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    (err) => err instanceof FreezeContinuityError && err.code === "ACTIVE_STATE_NOT_INACTIVE" && !err.message.includes(SECRET)
  );

  // 3. Secret in expectedGuardName
  assert.throws(
    () =>
      validateGuardUnit(
        {
          Id: "wrong-id",
          LoadState: "loaded",
          ActiveState: "active",
          MainPID: "123",
          InvocationID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        { expectedGuardName: "guard-" + SECRET }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "GUARD_UNIT_NAME_MISMATCH" && !err.message.includes(SECRET)
  );

  // 4. Secret in oldGuard Id
  assert.throws(
    () =>
      assertOldGuardHandoverStopped(
        {
          Id: "old-" + SECRET,
          LoadState: "loaded",
          ActiveState: "inactive",
          MainPID: "0",
        },
        { expectedOldGuardName: "target-old-guard" }
      ),
    (err) => err instanceof FreezeContinuityError && err.code === "OLD_GUARD_NAME_MISMATCH" && !err.message.includes(SECRET)
  );
});
