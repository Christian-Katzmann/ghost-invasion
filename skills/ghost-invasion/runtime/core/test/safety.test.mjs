import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptySafetyVerdict, evaluateSafety } from "../dist/safety.js";

const provenEgress = {
  mode: "container-firewall",
  proven: true,
  canaryMatrix: {
    "fetch:ghost-canary": "blocked",
    "fetch:fake-stripe": "blocked",
    "https.request:ghost-canary": "blocked",
    "http.request:ghost-canary": "blocked"
  },
  allowlist: ["localhost", "127.0.0.1"],
  dockerAvailable: true,
  errors: []
};

test("live keys block without leaking secret values", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-safety-"));
  try {
    const verdict = await evaluateSafety({
      baseUrl: "http://127.0.0.1:5173",
      cwd,
      env: { STRIPE_SECRET_KEY: "sk_live_1234567890abcdef" },
      egressProof: provenEgress,
      resetStrategy: "user-command",
      dataIsolation: "user-reset"
    });

    assert.equal(verdict.verdict, "block");
    assert.equal(verdict.targetRisk, "prod");
    assert.equal(verdict.liveSecrets[0]?.key, "STRIPE_SECRET_KEY");
    assert.equal(verdict.liveSecrets[0]?.last4, "cdef");
    assert.equal(JSON.stringify(verdict).includes("sk_live_1234567890abcdef"), false);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("localhost with a non-local database is production-risk", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-safety-"));
  try {
    const verdict = await evaluateSafety({
      baseUrl: "http://localhost:5173",
      cwd,
      env: { DATABASE_URL: "postgres://app:secret@db.example.com:5432/app" },
      egressProof: provenEgress,
      resetStrategy: "user-command",
      dataIsolation: "user-reset"
    });

    assert.equal(verdict.verdict, "block");
    assert.equal(verdict.targetRisk, "prod");
    assert.match(verdict.explain, /database/i);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("mutating runs fail closed when egress is not proven", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-safety-"));
  try {
    const verdict = await evaluateSafety({
      baseUrl: "http://127.0.0.1:5173",
      cwd,
      env: {},
      runEgressCanary: false,
      resetStrategy: "user-command",
      dataIsolation: "user-reset"
    });

    assert.equal(verdict.verdict, "block");
    assert.equal(verdict.egress.proven, false);
    assert.match(verdict.explain, /egress trap is not proven/i);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("read-only attach mode can proceed without a proven egress trap", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-safety-"));
  try {
    const verdict = await evaluateSafety({
      baseUrl: "http://127.0.0.1:5173",
      cwd,
      env: {},
      mutating: false,
      runEgressCanary: false
    });

    assert.equal(verdict.verdict, "allow-with-warnings");
    assert.equal(verdict.egress.mode, "attach-only");
    assert.match(verdict.explain, /warnings/i);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("Stripe stays blocked by default and switches to localstripe only for payments mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-safety-"));
  try {
    const quick = await evaluateSafety({
      baseUrl: "http://127.0.0.1:5173",
      cwd,
      env: {},
      egressProof: provenEgress,
      resetStrategy: "user-command",
      dataIsolation: "user-reset",
      approvedPlanHash: "sha256:test"
    });
    const payments = await evaluateSafety({
      baseUrl: "http://127.0.0.1:5173",
      cwd,
      env: {},
      mode: "payments",
      egressProof: provenEgress,
      resetStrategy: "user-command",
      dataIsolation: "user-reset",
      approvedPlanHash: "sha256:test"
    });

    assert.deepEqual(quick.mocksApplied.find((mock) => mock.service === "stripe"), {
      service: "stripe",
      via: "stripe:blocked-stub"
    });
    assert.deepEqual(payments.mocksApplied.find((mock) => mock.service === "stripe"), {
      service: "stripe",
      via: "stripe:localstripe"
    });
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("the unconfigured verdict is not the green word 'allow' (S-046)", async () => {
  // The first command a careful engineer runs must not be greeted with "allow" when
  // nothing has been configured yet. The empty verdict surfaces a distinct
  // not-configured state, and doctor with no target resolves the same way.
  const empty = createEmptySafetyVerdict();
  assert.equal(empty.verdict, "not-configured");
  assert.notEqual(empty.verdict, "allow");

  const noTarget = await evaluateSafety({});
  assert.equal(noTarget.verdict, "not-configured");
  assert.match(noTarget.explain, /no target/i);
});
