import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileInvasionPlan } from "../dist/planner.js";
import { evaluateSafety } from "../dist/safety.js";

// The egress container canary is disabled in these tests so they stay hermetic
// (no Docker, no OS dialogs). evaluateSafety() and compileInvasionPlan() both see
// an unproven trap, exactly as they would on a machine without Docker.

test("compiled plan.safety mirrors the canonical block verdict for a live-secret dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ghost-planner-"));
  try {
    // A local URL the old host-only heuristic would have called "local"/safe, paired
    // with a live Stripe key the hand-built block hardcoded away as liveSecrets:[].
    await writeFile(join(dir, ".env"), "STRIPE_SECRET_KEY=sk_live_planner_1234abcd\n", "utf8");
    const baseUrl = "http://127.0.0.1:5173";

    const { plan } = await compileInvasionPlan({ projectRoot: dir, baseUrl, runEgressCanary: false });
    const verdict = await evaluateSafety({
      baseUrl,
      cwd: dir,
      mode: "quick",
      mutating: true,
      resetStrategy: "none",
      dataIsolation: "unknown",
      runEgressCanary: false
    });

    // The verdict is the source of truth, and it blocks.
    assert.equal(verdict.verdict, "block");

    // plan.safety is stamped from that verdict, not a weaker hand-built copy.
    assert.equal(plan.safety.targetRisk, verdict.targetRisk);
    assert.equal(plan.safety.targetRisk, "prod");
    assert.equal(plan.safety.hardStop, verdict.hardStop);
    assert.equal(plan.safety.hardStop, true);
    assert.deepEqual(plan.safety.liveSecrets, verdict.liveSecrets);
    assert.deepEqual(plan.safety.dataReset, verdict.dataReset);
    assert.equal(plan.safety.approvalRequired, verdict.approvalRequired);

    // The live key is recorded as a signal, masked to its last 4 — never stamped raw.
    const stripeSignal = plan.safety.liveSecrets.find((secret) => secret.key === "STRIPE_SECRET_KEY");
    assert.ok(stripeSignal, "expected the live Stripe key to surface in plan.safety.liveSecrets");
    assert.equal(stripeSignal.severity, "block");
    assert.equal(JSON.stringify(plan).includes("sk_live_planner_1234abcd"), false);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("compiled plan.safety.mocksApplied is derived from the honest verdict, not hardcoded sinks (S-010)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ghost-planner-"));
  try {
    const baseUrl = "http://127.0.0.1:5173";
    const { plan } = await compileInvasionPlan({ projectRoot: dir, baseUrl, runEgressCanary: false });

    // Ghost ships no mailpit / s3-stub / webhook-sink servers; the report must not
    // over-claim sinks it never starts.
    for (const overClaim of ["email/mailpit", "storage/s3-stub", "webhook-sink"]) {
      assert.equal(
        plan.safety.mocksApplied.includes(overClaim),
        false,
        `mocksApplied must not over-claim the un-started sink ${overClaim}`
      );
    }

    // For a clean local dir the only contained service is Stripe (blocked via the
    // network trap outside payments mode) — exactly what the verdict reports.
    const verdict = await evaluateSafety({
      baseUrl,
      cwd: dir,
      mode: "quick",
      mutating: true,
      resetStrategy: "none",
      dataIsolation: "unknown",
      runEgressCanary: false
    });
    const expected = verdict.mocksApplied.map((mock) => (mock.service === "stripe" ? mock.via : mock.service));
    assert.deepEqual(plan.safety.mocksApplied, expected);
    assert.deepEqual(plan.safety.mocksApplied, ["stripe:blocked-stub"]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("compiled plan.safety mirrors the canonical block verdict for an off-box database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ghost-planner-"));
  try {
    await writeFile(join(dir, ".env"), "DATABASE_URL=postgres://app:secret@db.example.com:5432/app\n", "utf8");
    const baseUrl = "http://localhost:5173";

    const { plan } = await compileInvasionPlan({ projectRoot: dir, baseUrl, runEgressCanary: false });
    const verdict = await evaluateSafety({
      baseUrl,
      cwd: dir,
      mode: "quick",
      mutating: true,
      resetStrategy: "none",
      dataIsolation: "unknown",
      runEgressCanary: false
    });

    assert.equal(verdict.verdict, "block");
    assert.equal(plan.safety.targetRisk, "prod");
    assert.equal(plan.safety.hardStop, verdict.hardStop);
    assert.deepEqual(plan.safety.liveSecrets, verdict.liveSecrets);
    assert.deepEqual(plan.safety.dataReset, verdict.dataReset);
    // The off-box connection string is never copied verbatim into the plan.
    assert.equal(JSON.stringify(plan).includes("db.example.com"), false);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
