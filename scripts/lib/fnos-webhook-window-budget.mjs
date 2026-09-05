export class WindowBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WindowBudgetError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new WindowBudgetError(code, message);
}

const REQUIRED_FIELDS = Object.freeze([
  "guardRemainingMs",
  "referenceRemainingMs",
  "executeTimeoutMs",
  "freshDryBudgetMs",
  "forwardBudgetMs",
  "cutoverBudgetMs",
  "recoveryReserveMs",
]);

const REASON_CODES = Object.freeze({
  GUARD_WINDOW_EXCEEDED: "GUARD_WINDOW_EXCEEDED",
  REFERENCE_WINDOW_EXCEEDED: "REFERENCE_WINDOW_EXCEEDED",
  BOTH_WINDOWS_EXCEEDED: "BOTH_WINDOWS_EXCEEDED",
});

function validatePositiveSafeInteger(val, name) {
  if (typeof val !== "number") {
    fail("INPUT_NOT_NUMBER", `Field ${name} must be a number`);
  }
  if (Number.isNaN(val)) {
    fail("INPUT_IS_NAN", `Field ${name} cannot be NaN`);
  }
  if (!Number.isSafeInteger(val)) {
    fail("INPUT_NOT_SAFE_INTEGER", `Field ${name} must be a safe integer`);
  }
  if (val <= 0) {
    fail("INPUT_NOT_POSITIVE", `Field ${name} must be positive (> 0)`);
  }
  return val;
}

export function evaluateWindowBudget(inputs) {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    fail("INPUT_NOT_OBJECT", "inputs must be a plain object");
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(inputs, field)) {
      fail("MISSING_REQUIRED_FIELD", `Missing required field: ${field}`);
    }
  }

  const guardRemainingMs = validatePositiveSafeInteger(inputs.guardRemainingMs, "guardRemainingMs");
  const referenceRemainingMs = validatePositiveSafeInteger(inputs.referenceRemainingMs, "referenceRemainingMs");
  const executeTimeoutMs = validatePositiveSafeInteger(inputs.executeTimeoutMs, "executeTimeoutMs");
  const freshDryBudgetMs = validatePositiveSafeInteger(inputs.freshDryBudgetMs, "freshDryBudgetMs");
  const forwardBudgetMs = validatePositiveSafeInteger(inputs.forwardBudgetMs, "forwardBudgetMs");
  const cutoverBudgetMs = validatePositiveSafeInteger(inputs.cutoverBudgetMs, "cutoverBudgetMs");
  const recoveryReserveMs = validatePositiveSafeInteger(inputs.recoveryReserveMs, "recoveryReserveMs");

  const components = [
    executeTimeoutMs,
    freshDryBudgetMs,
    forwardBudgetMs,
    cutoverBudgetMs,
    recoveryReserveMs,
  ];

  let sum = 0;
  for (const component of components) {
    sum += component;
    if (!Number.isSafeInteger(sum) || sum > Number.MAX_SAFE_INTEGER) {
      fail("BUDGET_SUM_OVERFLOW", "Sum of budget components exceeds Number.MAX_SAFE_INTEGER");
    }
  }

  const requiredMs = sum;
  const guardMarginMs = guardRemainingMs - requiredMs;
  const referenceMarginMs = referenceRemainingMs - requiredMs;

  const guardPass = guardRemainingMs >= requiredMs;
  const referencePass = referenceRemainingMs >= requiredMs;
  const allowed = guardPass && referencePass;

  let reason = null;
  if (!allowed) {
    if (!guardPass && !referencePass) {
      reason = REASON_CODES.BOTH_WINDOWS_EXCEEDED;
    } else if (!guardPass) {
      reason = REASON_CODES.GUARD_WINDOW_EXCEEDED;
    } else {
      reason = REASON_CODES.REFERENCE_WINDOW_EXCEEDED;
    }
  }

  return Object.freeze({
    allowed,
    reason,
    requiredMs,
    guardMarginMs,
    referenceMarginMs,
    breakdown: Object.freeze({
      executeTimeoutMs,
      freshDryBudgetMs,
      forwardBudgetMs,
      cutoverBudgetMs,
      recoveryReserveMs,
    }),
  });
}

export function computeRemainingMonotonicMs(deadlineMonotonicMs, currentMonotonicMs) {
  const deadline = validatePositiveSafeInteger(deadlineMonotonicMs, "deadlineMonotonicMs");
  const current = validatePositiveSafeInteger(currentMonotonicMs, "currentMonotonicMs");

  const diff = deadline - current;
  if (!Number.isSafeInteger(diff)) {
    fail("MONOTONIC_DIFF_OVERFLOW", "Monotonic difference exceeds safe integer range");
  }
  return diff;
}
