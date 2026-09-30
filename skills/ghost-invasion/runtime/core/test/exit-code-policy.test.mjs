import assert from "node:assert/strict";
import test from "node:test";
import { parseExitCodeOnSeverity, reportMeetsExitCodeThreshold } from "../dist/exit-code-policy.js";
import { deriveRunStatus, ReportValidationError, validateReportJson } from "../dist/schemas/report.js";

const baseReport = {
  $schema: "ghost-invasion/report@1",
  schemaVersion: "1.0",
  runId: "run-test",
  target: { url: "http://127.0.0.1:4173", stack: "manual", allowProductionTarget: false },
  invasion: {
    personas: 1,
    journeys: 1,
    pack: "launch-readiness",
    browserSessions: 1,
    apiRequests: 0,
    apiEndpointsHit: 0,
    mode: "quick"
  },
  scale: { headline: "1 browser user" },
  runStatus: { state: "completed", egressProven: true, quarantined: false, degraded: false, clean: true },
  totals: { findings: 0, critical: 0, confirmedBugs: 0, needsHumanReview: 0, falsePositivesSuppressed: 0 },
  cost: {
    modelVersion: "test",
    currency: "USD",
    budgetUsd: 0,
    estimatedUsd: 0,
    actualUsd: 0,
    variancePct: 0,
    withinBudget: true,
    degraded: false,
    degradations: [],
    phases: [],
    assumptions: {
      version: "test",
      currency: "USD",
      llmInputUsdPer1kTokens: 0,
      llmOutputUsdPer1kTokens: 0,
      localBrowserSessionUsd: 0,
      localApiRequestUsd: 0,
      localReproductionAttemptUsd: 0,
      localReportRenderUsd: 0
    }
  },
  findings: [],
  safety: {
    mockedServices: [],
    dataResetStrategy: "none",
    egress: { mode: "attach-only", proven: false },
    dangerousEnvKeysDetected: []
  }
};

function finding(overrides = {}) {
  return {
    id: "F-001",
    title: "Confirmed issue",
    category: "confirmed-bug",
    severity: "critical",
    confidence: 0.93,
    invariant: "mutation.idempotent-create",
    affected: { surfaceId: "surface", route: "/projects/new" },
    reproducedAcross: { personas: 1, inputProfiles: 1, seeds: 1 },
    occurrences: 1,
    pristinePassed: true,
    reproductionRate: "1/1 attempts",
    mockDependent: false,
    evidence: ["evidence/trace.zip"],
    reproSteps: "reproduction-steps/F-001.md",
    generatedTest: "generated-tests/F-001.spec.ts",
    signals: [],
    ...overrides
  };
}

test("exit-code threshold matches confirmed findings at or above severity", () => {
  const report = { ...baseReport, findings: [finding({ severity: "high" })] };
  assert.equal(reportMeetsExitCodeThreshold(report, "critical"), false);
  assert.equal(reportMeetsExitCodeThreshold(report, "high"), true);
  assert.equal(reportMeetsExitCodeThreshold(report, "medium"), true);
});

test("exit-code threshold ignores non-confirmed findings", () => {
  const report = { ...baseReport, findings: [finding({ category: "needs-human-review", severity: "critical" })] };
  assert.equal(reportMeetsExitCodeThreshold(report, "critical"), false);
});

test("exit-code threshold fails non-zero for an unclean run with zero confirmed findings (F3, S-038, R1)", () => {
  // The dishonest hole: a dry-run / circuit-broken / egress-unproven / quarantined /
  // evidence-degraded run can produce 0 confirmed findings yet must NOT exit green — CI
  // keys off exactly that surface. runStatus.clean is the load-bearing boolean.
  const uncleanRunStatuses = [
    { state: "dry-run", egressProven: true, quarantined: false, degraded: false, clean: false },
    { state: "circuit-breaker", egressProven: true, quarantined: false, degraded: false, clean: false },
    { state: "completed", egressProven: false, quarantined: false, degraded: false, clean: false },
    { state: "completed", egressProven: true, quarantined: true, degraded: false, clean: false },
    { state: "completed", egressProven: true, quarantined: false, degraded: true, clean: false }
  ];
  for (const runStatus of uncleanRunStatuses) {
    const report = { ...baseReport, findings: [], runStatus };
    assert.equal(
      reportMeetsExitCodeThreshold(report, "critical"),
      true,
      `unclean run (${runStatus.state}, egress=${runStatus.egressProven}, quarantined=${runStatus.quarantined}, degraded=${runStatus.degraded}) must exit non-zero`
    );
  }
  // A genuinely clean run with no findings stays green.
  assert.equal(reportMeetsExitCodeThreshold({ ...baseReport, findings: [] }, "critical"), false);
});

test("deriveRunStatus forces clean:false when the evidence spine degraded (F4, R1)", () => {
  const base = { state: "completed", egressProven: true, quarantined: false };
  assert.equal(deriveRunStatus({ ...base, degraded: false }).clean, true);
  const degraded = deriveRunStatus({ ...base, degraded: true });
  assert.equal(degraded.clean, false, "a degraded evidence spine must never report clean");
  assert.equal(degraded.degraded, true, "the degraded flag must be surfaced on the run status");
});

test("exit-code severity parser is strict", () => {
  assert.equal(parseExitCodeOnSeverity("CRITICAL"), "critical");
  assert.throws(() => parseExitCodeOnSeverity("confirmed"));
});

test("a schema-valid report passes validation (S-020)", () => {
  const validated = validateReportJson(baseReport);
  assert.equal(validated.runId, "run-test");
  assert.equal(validated.runStatus.clean, true);
});

test("a critical-stripped / malformed report.json fails closed before the exit-code decision (S-020)", () => {
  // The exit-code path validates report.json before trusting it. A report whose
  // findings array was truncated to a non-array, or whose required fields were
  // hand-edited away, must throw rather than read green.
  const strippedFindings = { ...baseReport, findings: "[]" };
  assert.throws(() => validateReportJson(strippedFindings), ReportValidationError);

  const { totals, ...missingTotals } = baseReport;
  assert.throws(() => validateReportJson(missingTotals), ReportValidationError);

  const missingRunStatus = { ...baseReport };
  delete missingRunStatus.runStatus;
  assert.throws(() => validateReportJson(missingRunStatus), ReportValidationError);

  assert.throws(() => validateReportJson(JSON.parse("{")), SyntaxError);
});
