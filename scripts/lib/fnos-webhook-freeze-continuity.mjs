import { createHash } from "node:crypto";

/**
 * Fixed 5 Webhook Units on Cloud/fnOS
 */
export const REQUIRED_WEBHOOK_UNITS = Object.freeze([
  "shein-fm-webhook-hydration.timer",
  "shein-fm-webhook-hydration.path",
  "shein-fm-webhook-hydration.service",
  "shein-fm-webhook-worker.service",
  "shein-fm-webhook-receiver.service",
]);

export const SERVICE_UNITS = Object.freeze(
  REQUIRED_WEBHOOK_UNITS.filter((name) => name.endsWith(".service"))
);

export const NON_SERVICE_UNITS = Object.freeze(
  REQUIRED_WEBHOOK_UNITS.filter((name) => !name.endsWith(".service"))
);

const ALLOWED_INACTIVE_STATES = Object.freeze(["inactive", "failed"]);
const DECIMAL_STRING_PATTERN = /^[0-9]+$/;
const INVOCATION_ID_PATTERN = /^[0-9a-fA-F]{32}$/;

export class FreezeContinuityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FreezeContinuityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FreezeContinuityError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSafePid(rawPid, { requireZero = false, allowZero = true } = {}) {
  if (rawPid === undefined || rawPid === null) {
    fail("PID_FORMAT_INVALID", "PID field is missing");
  }
  const text = String(rawPid).trim();
  if (!DECIMAL_STRING_PATTERN.test(text)) {
    fail("PID_FORMAT_INVALID", "PID must be an unsigned decimal string");
  }
  const num = Number(text);
  if (!Number.isSafeInteger(num) || num < 0) {
    fail("PID_BOUND_INVALID", "PID is out of safe integer range");
  }
  if (requireZero && num !== 0) {
    fail("SERVICE_PID_NOT_ZERO", "Service MainPID must be zero");
  }
  if (!allowZero && num <= 0) {
    fail("GUARD_PID_INVALID", "Guard MainPID must be a positive safe integer");
  }
  return String(num);
}

/**
 * Validates the raw show dictionary for a single unit and returns a canonical fingerprint record.
 * Error messages NEVER reflect input data or unit names.
 */
export function validateUnitShowRecord(unitName, rawRecord) {
  if (!isPlainObject(rawRecord)) {
    fail("RECORD_NOT_AN_OBJECT", "Unit record must be a plain object");
  }

  const loadState = rawRecord.LoadState ?? rawRecord.loadState;
  if (typeof loadState !== "string" || loadState.trim().toLowerCase() !== "loaded") {
    fail("UNIT_LOAD_STATE_NOT_LOADED", "Unit LoadState must be explicitly loaded");
  }

  const id = rawRecord.Id ?? rawRecord.id;
  if (typeof id !== "string" || id.trim() !== unitName) {
    fail("UNIT_ID_MISMATCH", "Unit Id does not match contracted unit");
  }

  const activeState = rawRecord.ActiveState ?? rawRecord.activeState;
  if (typeof activeState !== "string" || !ALLOWED_INACTIVE_STATES.includes(activeState.trim().toLowerCase())) {
    fail("ACTIVE_STATE_NOT_INACTIVE", "Unit ActiveState must be inactive or failed");
  }

  const activeEnterMonoRaw = rawRecord.ActiveEnterTimestampMonotonic ?? rawRecord.activeEnterTimestampMonotonic;
  const inactiveEnterMonoRaw = rawRecord.InactiveEnterTimestampMonotonic ?? rawRecord.inactiveEnterTimestampMonotonic;

  if (activeEnterMonoRaw === undefined || activeEnterMonoRaw === null || !DECIMAL_STRING_PATTERN.test(String(activeEnterMonoRaw).trim())) {
    fail("TIMESTAMP_FORMAT_INVALID", "ActiveEnterTimestampMonotonic must be an unsigned integer string");
  }
  if (inactiveEnterMonoRaw === undefined || inactiveEnterMonoRaw === null || !DECIMAL_STRING_PATTERN.test(String(inactiveEnterMonoRaw).trim())) {
    fail("TIMESTAMP_FORMAT_INVALID", "InactiveEnterTimestampMonotonic must be an unsigned integer string");
  }

  const activeEnterMonoStr = String(activeEnterMonoRaw).trim();
  const inactiveEnterMonoStr = String(inactiveEnterMonoRaw).trim();

  // Inactive monotonic timestamp must be non-zero for stopped unit
  if (Number(inactiveEnterMonoStr) === 0) {
    fail("INACTIVE_TIMESTAMP_ZERO", "InactiveEnterTimestampMonotonic cannot be zero for stopped unit");
  }

  const isService = unitName.endsWith(".service");
  let mainPid = null;
  let invocationId = null;

  if (isService) {
    const mainPidRaw = rawRecord.MainPID ?? rawRecord.mainPid;
    mainPid = parseSafePid(mainPidRaw, { requireZero: true });

    const invRaw = rawRecord.InvocationID ?? rawRecord.invocationId;
    if (invRaw === undefined || invRaw === null || typeof invRaw !== "string" || !INVOCATION_ID_PATTERN.test(invRaw.trim())) {
      fail("INVOCATION_ID_INVALID", "Service InvocationID must be a 32-character hexadecimal string");
    }
    invocationId = invRaw.trim();
  } else {
    // Non-service units (timer/path): if InvocationID is present on systemd, capture it; if absent/empty, set null
    const invRaw = rawRecord.InvocationID ?? rawRecord.invocationId;
    if (invRaw !== undefined && invRaw !== null && String(invRaw).trim() !== "") {
      const invStr = String(invRaw).trim();
      if (!INVOCATION_ID_PATTERN.test(invStr)) {
        fail("INVOCATION_ID_INVALID", "Non-service InvocationID if present must be a 32-character hexadecimal string");
      }
      invocationId = invStr;
    } else {
      invocationId = null;
    }
  }

  return Object.freeze({
    id: unitName,
    loadState: "loaded",
    activeState: activeState.trim().toLowerCase(),
    activeEnterTimestampMonotonic: activeEnterMonoStr,
    inactiveEnterTimestampMonotonic: inactiveEnterMonoStr,
    mainPid,
    invocationId,
  });
}

function computeFingerprint(validatedUnits) {
  const fingerprintSource = Object.entries(validatedUnits)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([_, rec]) => JSON.stringify(rec))
    .join("\n");
  return createHash("sha256").update(fingerprintSource, "utf8").digest("hex");
}

/**
 * Validates structured systemctl show map for all 5 webhook units and returns a frozen snapshot.
 * unitsMap must have exactly the 5 required keys.
 */
export function captureFreezeBaseline(unitsMap) {
  if (!isPlainObject(unitsMap)) {
    fail("UNITS_MAP_INVALID", "unitsMap must be a plain object");
  }

  const providedKeys = Object.keys(unitsMap).sort();
  const expectedKeys = [...REQUIRED_WEBHOOK_UNITS].sort();

  if (providedKeys.length !== expectedKeys.length || !providedKeys.every((k, i) => k === expectedKeys[i])) {
    fail("REQUIRED_UNITS_SET_MISMATCH", "unitsMap must contain exactly the contracted 5 webhook units");
  }

  const validatedUnits = {};
  for (const unitName of REQUIRED_WEBHOOK_UNITS) {
    validatedUnits[unitName] = validateUnitShowRecord(unitName, unitsMap[unitName]);
  }

  const freezeFingerprint = computeFingerprint(validatedUnits);

  return Object.freeze({
    freezeFingerprint,
    units: Object.freeze(validatedUnits),
  });
}

/**
 * Asserts that the current show state matches the freeze baseline exactly.
 * Baseline object is validated strictly: must contain 5 units and matching internal fingerprint.
 * Even if current state is inactive, any difference in timestamps, invocationId, or MainPID fails closed.
 */
export function assertFreezeContinuity(baseline, currentUnitsMap) {
  if (!isPlainObject(baseline) || typeof baseline.freezeFingerprint !== "string" || !isPlainObject(baseline.units)) {
    fail("BASELINE_INVALID", "Baseline object is missing or invalid");
  }

  // Fully re-validate baseline.units through captureFreezeBaseline to ensure every record is valid and canonical
  let verifiedBaseline;
  try {
    verifiedBaseline = captureFreezeBaseline(baseline.units);
  } catch (err) {
    fail("BASELINE_UNITS_INVALID", "Baseline units failed schema validation");
  }

  if (baseline.freezeFingerprint !== verifiedBaseline.freezeFingerprint) {
    fail("BASELINE_FINGERPRINT_CORRUPT", "Baseline units do not match baseline freezeFingerprint");
  }

  // Capture current state using strict validation
  const currentCapture = captureFreezeBaseline(currentUnitsMap);

  if (currentCapture.freezeFingerprint !== baseline.freezeFingerprint) {
    for (const unitName of REQUIRED_WEBHOOK_UNITS) {
      const baseRec = baseline.units[unitName];
      const curRec = currentCapture.units[unitName];

      if (baseRec.activeEnterTimestampMonotonic !== curRec.activeEnterTimestampMonotonic ||
          baseRec.inactiveEnterTimestampMonotonic !== curRec.inactiveEnterTimestampMonotonic) {
        fail("UNIT_LIFECYCLE_TIMESTAMP_DRIFT", "Unit lifecycle monotonic timestamp changed since baseline");
      }
      if (baseRec.invocationId !== curRec.invocationId) {
        fail("UNIT_INVOCATION_DRIFT", "Unit invocation ID changed since baseline");
      }
      if (baseRec.activeState !== curRec.activeState || baseRec.mainPid !== curRec.mainPid) {
        fail("UNIT_STATE_DRIFT", "Unit state or MainPID diverged from baseline");
      }
    }
    fail("FREEZE_CONTINUITY_BROKEN", "Freeze fingerprint diverged between baseline and readback");
  }

  return true;
}

/**
 * Validates a replacement guard unit:
 * - LoadState must be explicitly 'loaded'
 * - Must match expectedGuardName
 * - Must be active
 * - MainPID must be a positive safe integer > 0
 * - InvocationID must be a 32-char hex string and DIFFERENT from previousGuardInvocationId
 */
export function validateGuardUnit(guardRecord, { expectedGuardName, previousGuardInvocationId = null }) {
  if (!isPlainObject(guardRecord)) {
    fail("GUARD_RECORD_INVALID", "Guard record must be a plain object");
  }

  const loadState = guardRecord.LoadState ?? guardRecord.loadState;
  if (typeof loadState !== "string" || loadState.trim().toLowerCase() !== "loaded") {
    fail("GUARD_NOT_LOADED", "Guard unit LoadState must be explicitly loaded");
  }

  const id = guardRecord.Id ?? guardRecord.id;
  if (typeof id !== "string" || id.trim() !== expectedGuardName) {
    fail("GUARD_UNIT_NAME_MISMATCH", "Guard unit Id does not match expected name");
  }

  const activeState = guardRecord.ActiveState ?? guardRecord.activeState;
  if (typeof activeState !== "string" || activeState.trim().toLowerCase() !== "active") {
    fail("GUARD_NOT_ACTIVE", "Guard unit ActiveState must be active");
  }

  const mainPidRaw = guardRecord.MainPID ?? guardRecord.mainPid;
  const mainPid = parseSafePid(mainPidRaw, { allowZero: false });

  const invRaw = guardRecord.InvocationID ?? guardRecord.invocationId;
  if (invRaw === undefined || invRaw === null || typeof invRaw !== "string" || !INVOCATION_ID_PATTERN.test(invRaw.trim())) {
    fail("GUARD_INVOCATION_INVALID", "Guard InvocationID must be a 32-character hexadecimal string");
  }
  const invocationId = invRaw.trim();

  if (previousGuardInvocationId && invocationId === String(previousGuardInvocationId).trim()) {
    fail("GUARD_INVOCATION_REUSED", "Guard must not reuse previous guard invocation ID");
  }

  return Object.freeze({
    id: expectedGuardName,
    loadState: "loaded",
    activeState: "active",
    mainPid,
    invocationId,
  });
}

/**
 * Verifies handover of old guard:
 * - LoadState must be explicitly 'loaded' (cannot be 'not-found', missing, or unknown)
 * - Old guard must be terminal (inactive or failed), MainPID === 0.
 */
export function assertOldGuardHandoverStopped(oldGuardRecord, { expectedOldGuardName }) {
  if (!oldGuardRecord || !isPlainObject(oldGuardRecord)) {
    fail("OLD_GUARD_ABSENT", "Old guard record is missing or not an object");
  }

  const loadState = oldGuardRecord.LoadState ?? oldGuardRecord.loadState;
  if (typeof loadState !== "string" || loadState.trim().toLowerCase() !== "loaded") {
    fail("OLD_GUARD_NOT_LOADED", "Old guard LoadState must be explicitly loaded");
  }

  const id = oldGuardRecord.Id ?? oldGuardRecord.id;
  if (typeof id !== "string" || id.trim() !== expectedOldGuardName) {
    fail("OLD_GUARD_NAME_MISMATCH", "Old guard Id does not match expected name");
  }

  const activeState = oldGuardRecord.ActiveState ?? oldGuardRecord.activeState;
  if (typeof activeState !== "string" || !ALLOWED_INACTIVE_STATES.includes(activeState.trim().toLowerCase())) {
    fail("OLD_GUARD_STILL_ACTIVE", "Old guard ActiveState must be inactive or failed");
  }

  const mainPidRaw = oldGuardRecord.MainPID ?? oldGuardRecord.mainPid;
  const pid = parseSafePid(mainPidRaw, { requireZero: false });
  if (Number(pid) !== 0) {
    fail("OLD_GUARD_STILL_RUNNING", "Old guard MainPID must be zero");
  }

  return true;
}
