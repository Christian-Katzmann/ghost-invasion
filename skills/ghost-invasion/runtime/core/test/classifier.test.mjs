import assert from "node:assert/strict";
import test from "node:test";
import { applyConfidenceCeilings, compareFindings, enforceEvidenceGuardrail } from "../dist/classifier.js";

function findingFixture(overrides = {}) {
  return {
    $schema: "ghost-invasion/finding@1",
    id: "F-001",
    title: "Example finding",
    category: "confirmed-bug",
    severity: "critical",
    confidence: 0.9,
    invariant: "mutation.idempotent-create",
    affected: { surfaceId: "core.projects.create", route: "/projects/new" },
    reproducedAcross: { personas: 1, inputProfiles: 1, seeds: 1 },
    occurrences: 1,
    pristinePassed: true,
    reproductionRate: "1/1 attempts",
    mockDependent: false,
    signals: [],
    expected: "One row inserted",
    actual: "Two rows inserted",
    evidence: ["events.jsonl"],
    reproSteps: "reproduction-steps/F-001.md",
    minimalRepro: null,
    suggestedFix: "Add an idempotency key.",
    generatedTest: "generated-tests/F-001.spec.ts",
    ...overrides
  };
}

function ceiling(overrides = {}) {
  return applyConfidenceCeilings({
    category: "confirmed-bug",
    confidence: 0.99,
    pristinePassed: true,
    mockDependent: false,
    invariantClass: "hard",
    evidenceKinds: ["trace", "replay"],
    claimKind: "state-change",
    proofComplete: true,
    ...overrides
  });
}

test("state-change findings without DB diffs cannot be confirmed", () => {
  const result = ceiling({ evidenceKinds: ["trace", "replay"], proofComplete: false });

  assert.equal(result.category, "suspicious");
  assert(result.confidence <= 0.75);
  assert(result.reasons.includes("no-db-diff-state-change"));
});

test("pristine failures quarantine findings for human review", () => {
  const result = ceiling({ pristinePassed: false, evidenceKinds: ["db_diff", "trace", "replay"] });

  assert.equal(result.category, "needs-human-review");
  assert(result.confidence <= 0.6);
  assert(result.reasons.includes("pristine-failed"));
});

test("mock-dependent findings are capped at 0.80", () => {
  const result = ceiling({ mockDependent: true, evidenceKinds: ["db_diff", "trace", "replay"] });

  assert.equal(result.category, "confirmed-bug");
  assert(result.confidence <= 0.8);
  assert(result.reasons.includes("mock-dependent"));
});

test("missing trace or replay prevents confirmed findings", () => {
  const result = ceiling({ evidenceKinds: ["db_diff"], proofComplete: false });

  assert.equal(result.category, "suspicious");
  assert(result.confidence <= 0.65);
  assert(result.reasons.includes("missing-trace-replay"));
});

test("soft invariants are capped at needs-human-review", () => {
  const result = ceiling({
    invariantClass: "soft",
    evidenceKinds: ["trace", "replay", "screenshot"],
    claimKind: "ux-trap"
  });

  assert.equal(result.category, "needs-human-review");
  assert(result.confidence <= 0.7);
  assert(result.reasons.includes("soft-invariant"));
});

test("hard invariants with conclusive proof may remain confirmed from one hit", () => {
  const result = ceiling({ evidenceKinds: ["db_diff", "trace", "replay"], proofComplete: true });

  assert.equal(result.category, "confirmed-bug");
  assert.equal(result.confidence, 0.99);
  assert.deepEqual(result.reasons, []);
});

test("a finding with no bound proof beyond events.jsonl is forced to needs-human-review", () => {
  const guarded = enforceEvidenceGuardrail(findingFixture({ category: "confirmed-bug", evidence: ["events.jsonl"] }));

  assert.equal(guarded.category, "needs-human-review");
  assert(guarded.signals.includes("ceiling:no-bound-evidence"));
});

test("a finding with a bound proof artifact keeps its confirmed category", () => {
  const guarded = enforceEvidenceGuardrail(
    findingFixture({ category: "confirmed-bug", evidence: ["evidence/x/trace.zip", "events.jsonl"] })
  );

  assert.equal(guarded.category, "confirmed-bug");
  assert(!guarded.signals.includes("ceiling:no-bound-evidence"));
});

test("compareFindings tie-breaks equal-rank findings by id for stable ordering", () => {
  const higherId = findingFixture({ id: "F-002" });
  const lowerId = findingFixture({ id: "F-001" });

  assert.deepEqual([higherId, lowerId].sort(compareFindings).map((finding) => finding.id), ["F-001", "F-002"]);
  assert.deepEqual([lowerId, higherId].sort(compareFindings).map((finding) => finding.id), ["F-001", "F-002"]);
});
