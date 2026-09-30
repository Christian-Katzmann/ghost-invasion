import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COST_ASSUMPTIONS, estimateRunCost, normalizeBudgetUsd, planRunCost } from "../dist/cost-model.js";

// Assumptions that give the local phases a non-zero per-unit price so the budget
// ladder has something real to cut. The default assumptions price local work at $0,
// which is why "--budget-usd=0 spends nothing" is only vacuously true today.
const pricedLocal = {
  version: "test-priced-local",
  currency: "USD",
  llmInputUsdPer1kTokens: 0.005,
  llmOutputUsdPer1kTokens: 0.015,
  localBrowserSessionUsd: 2,
  localApiRequestUsd: 1,
  localReproductionAttemptUsd: 1,
  localReportRenderUsd: 0
};

test("normalizeBudgetUsd rejects negative and non-finite budgets", () => {
  assert.throws(() => normalizeBudgetUsd(-1), /--budget-usd must be a non-negative number/);
  assert.throws(() => normalizeBudgetUsd(Number.NaN), /--budget-usd must be a non-negative number/);
  assert.equal(normalizeBudgetUsd(undefined), undefined);
  assert.equal(normalizeBudgetUsd(0), 0);
});

test("estimateRunCost prices the classifier phase from token assumptions", () => {
  const cost = estimateRunCost({
    shape: {
      mode: "quick",
      browserSessions: 0,
      apiRequests: 0,
      reproductionAttempts: 0,
      classifierInputTokens: 2000,
      classifierOutputTokens: 1000
    }
  });

  const classify = cost.phases.find((phase) => phase.name === "classify");
  // 2000/1000 * 0.005 + 1000/1000 * 0.015 = 0.01 + 0.015
  assert.equal(classify?.estimatedUsd, 0.025);
  assert.equal(cost.estimatedUsd, 0.025);
  assert.equal(cost.withinBudget, true);
});

test("--budget-usd=0 commits the replay path and spends nothing on free local work", () => {
  const decision = planRunCost({
    shape: { mode: "quick", browserSessions: 5, apiRequests: 0, reproductionAttempts: 5 },
    budgetUsd: 0
  });

  assert.equal(decision.cost.estimatedUsd, 0);
  assert.equal(decision.cost.withinBudget, true);
  assert.equal(decision.cost.degraded, true);
  assert.ok(
    decision.cost.degradations.includes("llm-phases-skipped:replay-committed-plan"),
    `expected replay degradation, got ${JSON.stringify(decision.cost.degradations)}`
  );
  // The local phases are not silently dropped — the run still plans its sessions/reruns.
  assert.equal(decision.shape.browserSessions, 5);
  assert.equal(decision.reproductionBudget, 5);
});

test("--budget-usd=0 fails closed once a phase actually spends (LLM phase wired in)", () => {
  // The day a classifier LLM phase costs money, a $0 cap must refuse rather than
  // silently overspend: token cost cannot be cut by the reduction ladder.
  assert.throws(
    () =>
      planRunCost({
        shape: {
          mode: "deep",
          browserSessions: 1,
          apiRequests: 0,
          reproductionAttempts: 0,
          classifierInputTokens: 100_000
        },
        budgetUsd: 0
      }),
    /below the minimum estimated run cost/
  );
});

test("a budget below the minimum run cost throws instead of pretending to fit", () => {
  assert.throws(
    () =>
      planRunCost({
        shape: { mode: "quick", browserSessions: 1, apiRequests: 0, reproductionAttempts: 0, reportRenders: 0 },
        budgetUsd: 1,
        assumptions: pricedLocal
      }),
    /--budget-usd 1 is below the minimum estimated run cost 2/
  );
});

test("the reduction ladder cuts reproduction, then API, before touching browser sessions", () => {
  // estimate = 2*$2 browser + 3*$1 api + 3*$1 repro = $10; budget $6.
  const decision = planRunCost({
    shape: { mode: "deep", browserSessions: 2, apiRequests: 3, reproductionAttempts: 3 },
    budgetUsd: 6,
    assumptions: pricedLocal
  });

  assert.equal(decision.shape.reproductionAttempts, 0);
  assert.equal(decision.shape.apiRequests, 2);
  assert.equal(decision.shape.browserSessions, 2, "browser sessions must be preserved while cheaper levers remain");
  assert.equal(decision.cost.estimatedUsd, 6);
  assert.equal(decision.cost.withinBudget, true);
  assert.equal(decision.apiRequestBudget, 2);
  assert.equal(decision.reproductionBudget, 0);
  assert.ok(decision.cost.degradations.includes("reproduction-budget-reduced:3->0"));
  assert.ok(decision.cost.degradations.includes("api-requests-reduced:3->2"));
});

test("browser sessions are the last lever cut and never drop below one", () => {
  // Only browser sessions cost money here; the ladder must cut them but floor at 1.
  const browserOnly = { ...pricedLocal, localApiRequestUsd: 0, localReproductionAttemptUsd: 0 };
  const decision = planRunCost({
    shape: { mode: "deep", browserSessions: 5, apiRequests: 0, reproductionAttempts: 0 },
    budgetUsd: 2,
    assumptions: browserOnly
  });

  assert.equal(decision.shape.browserSessions, 1);
  assert.equal(decision.cost.estimatedUsd, 2);
  assert.ok(decision.cost.degradations.includes("browser-sessions-reduced:5->1"));
});

test("the default assumptions are the free-local baseline the vacuous cap relied on", () => {
  // Documents the root cause: every local phase is $0 by default, so nothing spends.
  assert.equal(DEFAULT_COST_ASSUMPTIONS.localBrowserSessionUsd, 0);
  assert.equal(DEFAULT_COST_ASSUMPTIONS.localApiRequestUsd, 0);
  assert.equal(DEFAULT_COST_ASSUMPTIONS.localReproductionAttemptUsd, 0);
  assert.equal(DEFAULT_COST_ASSUMPTIONS.localReportRenderUsd, 0);
});
