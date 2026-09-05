import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateWindowBudget,
  computeRemainingMonotonicMs,
  WindowBudgetError,
} from "../../scripts/lib/fnos-webhook-window-budget.mjs";

test("Window budget evaluation passes when guard and reference exactly equal required sum", () => {
  const components = {
    executeTimeoutMs: 60_000,
    freshDryBudgetMs: 30_000,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };
  const requiredSum = 60_000 + 30_000 + 120_000 + 90_000 + 150_000; // 450,000

  const result = evaluateWindowBudget({
    guardRemainingMs: requiredSum,
    referenceRemainingMs: requiredSum,
    ...components,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
  assert.equal(result.requiredMs, requiredSum);
  assert.equal(result.guardMarginMs, 0);
  assert.equal(result.referenceMarginMs, 0);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.breakdown));
});

test("Window budget evaluation passes with positive margins", () => {
  const components = {
    executeTimeoutMs: 60_000,
    freshDryBudgetMs: 30_000,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };
  const requiredSum = 450_000;

  const result = evaluateWindowBudget({
    guardRemainingMs: requiredSum + 10_000,
    referenceRemainingMs: requiredSum + 5_000,
    ...components,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
  assert.equal(result.requiredMs, requiredSum);
  assert.equal(result.guardMarginMs, 10_000);
  assert.equal(result.referenceMarginMs, 5_000);
});

test("Window budget evaluation rejects when guardRemainingMs is short by 1ms", () => {
  const components = {
    executeTimeoutMs: 60_000,
    freshDryBudgetMs: 30_000,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };
  const requiredSum = 450_000;

  const result = evaluateWindowBudget({
    guardRemainingMs: requiredSum - 1,
    referenceRemainingMs: requiredSum,
    ...components,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "GUARD_WINDOW_EXCEEDED");
  assert.equal(result.requiredMs, requiredSum);
  assert.equal(result.guardMarginMs, -1);
  assert.equal(result.referenceMarginMs, 0);
});

test("Window budget evaluation rejects when referenceRemainingMs is shorter than required", () => {
  const components = {
    executeTimeoutMs: 60_000,
    freshDryBudgetMs: 30_000,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };
  const requiredSum = 450_000;

  const result = evaluateWindowBudget({
    guardRemainingMs: requiredSum + 100_000,
    referenceRemainingMs: requiredSum - 1,
    ...components,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "REFERENCE_WINDOW_EXCEEDED");
  assert.equal(result.requiredMs, requiredSum);
  assert.equal(result.guardMarginMs, 100_000);
  assert.equal(result.referenceMarginMs, -1);
});

test("Window budget evaluation reports BOTH_WINDOWS_EXCEEDED when both guard and reference are short", () => {
  const components = {
    executeTimeoutMs: 60_000,
    freshDryBudgetMs: 30_000,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };
  const requiredSum = 450_000;

  const result = evaluateWindowBudget({
    guardRemainingMs: requiredSum - 5_000,
    referenceRemainingMs: requiredSum - 10_000,
    ...components,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "BOTH_WINDOWS_EXCEEDED");
  assert.equal(result.requiredMs, requiredSum);
  assert.equal(result.guardMarginMs, -5_000);
  assert.equal(result.referenceMarginMs, -10_000);
});

test("Window budget evaluation fails closed on missing parameters", () => {
  const valid = {
    guardRemainingMs: 500_000,
    referenceRemainingMs: 500_000,
    executeTimeoutMs: 60_000,
    freshDryBudgetMs: 30_000,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };

  for (const key of Object.keys(valid)) {
    const copy = { ...valid };
    delete copy[key];
    assert.throws(
      () => evaluateWindowBudget(copy),
      (error) => error instanceof WindowBudgetError && error.code === "MISSING_REQUIRED_FIELD",
    );
  }

  assert.throws(
    () => evaluateWindowBudget(null),
    (error) => error instanceof WindowBudgetError && error.code === "INPUT_NOT_OBJECT",
  );
  assert.throws(
    () => evaluateWindowBudget("string"),
    (error) => error instanceof WindowBudgetError && error.code === "INPUT_NOT_OBJECT",
  );
  assert.throws(
    () => evaluateWindowBudget([]),
    (error) => error instanceof WindowBudgetError && error.code === "INPUT_NOT_OBJECT",
  );
});

test("Window budget evaluation rejects non-numbers, NaN, floats, zero, and negative values", () => {
  const base = {
    guardRemainingMs: 500_000,
    referenceRemainingMs: 500_000,
    executeTimeoutMs: 60_000,
    freshDryBudgetMs: 30_000,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };

  const testCases = [
    { value: "500000", expectedCode: "INPUT_NOT_NUMBER" },
    { value: null, expectedCode: "INPUT_NOT_NUMBER" },
    { value: undefined, expectedCode: "INPUT_NOT_NUMBER" },
    { value: NaN, expectedCode: "INPUT_IS_NAN" },
    { value: 500.5, expectedCode: "INPUT_NOT_SAFE_INTEGER" },
    { value: 0, expectedCode: "INPUT_NOT_POSITIVE" },
    { value: -1, expectedCode: "INPUT_NOT_POSITIVE" },
    { value: -100_000, expectedCode: "INPUT_NOT_POSITIVE" },
    { value: Number.MAX_SAFE_INTEGER + 1, expectedCode: "INPUT_NOT_SAFE_INTEGER" },
    { value: Infinity, expectedCode: "INPUT_NOT_SAFE_INTEGER" },
    { value: -Infinity, expectedCode: "INPUT_NOT_SAFE_INTEGER" },
  ];

  for (const field of Object.keys(base)) {
    for (const { value, expectedCode } of testCases) {
      assert.throws(
        () => evaluateWindowBudget({ ...base, [field]: value }),
        (error) => error instanceof WindowBudgetError && error.code === expectedCode,
      );
    }
  }
});

test("Window budget evaluation rejects when sum of components overflows MAX_SAFE_INTEGER", () => {
  const base = {
    guardRemainingMs: 500_000,
    referenceRemainingMs: 500_000,
    executeTimeoutMs: Number.MAX_SAFE_INTEGER - 10,
    freshDryBudgetMs: 20,
    forwardBudgetMs: 120_000,
    cutoverBudgetMs: 90_000,
    recoveryReserveMs: 150_000,
  };

  assert.throws(
    () => evaluateWindowBudget(base),
    (error) => error instanceof WindowBudgetError && error.code === "BUDGET_SUM_OVERFLOW",
  );
});

test("computeRemainingMonotonicMs computes exact difference with strict validation", () => {
  const diff = computeRemainingMonotonicMs(100_000, 40_000);
  assert.equal(diff, 60_000);

  const pastDiff = computeRemainingMonotonicMs(40_000, 100_000);
  assert.equal(pastDiff, -60_000);

  assert.throws(
    () => computeRemainingMonotonicMs("100000", 40000),
    (error) => error instanceof WindowBudgetError && error.code === "INPUT_NOT_NUMBER",
  );
  assert.throws(
    () => computeRemainingMonotonicMs(0, 40000),
    (error) => error instanceof WindowBudgetError && error.code === "INPUT_NOT_POSITIVE",
  );
  assert.throws(
    () => computeRemainingMonotonicMs(100000, 0),
    (error) => error instanceof WindowBudgetError && error.code === "INPUT_NOT_POSITIVE",
  );
  assert.throws(
    () => computeRemainingMonotonicMs(100.5, 40),
    (error) => error instanceof WindowBudgetError && error.code === "INPUT_NOT_SAFE_INTEGER",
  );
});
