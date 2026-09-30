import assert from "node:assert/strict";
import test from "node:test";
import {
  elevatedRunModes,
  formatRunModeEcho,
  preparePlanForRunMode,
  runModeHelpText,
  selectRunMode,
  stripeBlockedStubService,
  stripeLocalstripeService
} from "../dist/run-modes.js";

function basePlan() {
  return {
    $schema: "ghost-invasion/plan@1",
    createdAt: new Date().toISOString(),
    target: { baseUrl: "http://127.0.0.1:5173", stack: "manual", auth: "generic" },
    mode: "quick",
    pack: "launch-readiness",
    seed: 1337,
    safety: {
      targetRisk: "local",
      hardStop: false,
      egress: { mode: "container-firewall", proven: true, allowlist: ["localhost", "127.0.0.1", "localstripe"] },
      liveSecrets: [],
      mocksApplied: [stripeBlockedStubService],
      dataReset: { strategy: "user-command", isolation: "user-reset", destructiveAllowed: true },
      approvalRequired: false
    },
    swarm: {
      browserConcurrency: 1,
      browserWaves: 1,
      totalBrowserSessions: 1,
      apiTier: { enabled: false, engine: "fetch", rps: 0, targets: [] },
      rateLimits: { rampMsPerContext: 750, circuitBreaker: "3%5xx|429" }
    },
    personas: [
      {
        $schema: "ghost-invasion/persona@1",
        id: "permission-boundary-user",
        archetype: "permission_boundary_user",
        role: { name: "member", authStrategy: "none", stateRef: null },
        device: { preset: "Desktop Chrome", viewport: { width: 1280, height: 800 }, touch: false, scaleFactor: 1 },
        network: { profile: "fast", downKbps: 10000, upKbps: 5000, latencyMs: 20 },
        patience: { actionTimeoutMs: 5000, maxWaitBeforeRageMs: 5000, giveUpAfterSteps: 4 },
        mistakePattern: { missThreshold: 0, doubleSubmit: false, refreshMidFlow: false, backDuringSave: false, typoRate: 0 },
        timing: { thinkTimeMs: [0, 0], typeDelayMs: [0, 0] },
        dataState: { inputProfile: "tenant-fixture", recordCountBefore: 2, fixtureRef: "projectly-tenants" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "cross-tenant-project-read",
        name: "Cross-tenant project read is blocked",
        goal: "User A must not read User B's private project.",
        appliesToPersonas: ["permission-boundary-user"],
        invariantsTested: ["auth.no-cross-tenant-read"],
        pristineRequired: false,
        anchors: {
          routes: ["/projects/project-user-b-private"],
          mutations: ["GET /projects/project-user-b-private"],
          surfaceHash: "sha256:test"
        },
        idealPath: ["apiCall:GET:/projects/project-user-b-private:expect404"],
        steps: [{ type: "apiCall", method: "GET", url: "/projects/project-user-b-private", expectStatus: 404 }],
        success: [{ type: "wait", ms: 0 }],
        abandon: []
      }
    ],
    surfaceHash: "sha256:test",
    approvedPlanHash: null
  };
}

test("selectRunMode rejects ambiguous mode flags", () => {
  assert.equal(selectRunMode({ payments: true }), "payments");
  assert.throws(() => selectRunMode({ payments: true, permission: true }), /Choose one run mode/);
});

test("formatRunModeEcho reports the resolved mode the run will use", () => {
  // No flag → the plan's own mode (quick by default), made explicit in the echo.
  assert.equal(formatRunModeEcho({}), "Run mode: quick (plan default)");
  // Exactly one flag → that mode is echoed verbatim.
  assert.equal(formatRunModeEcho({ payments: true }), "Run mode: payments");
  assert.equal(formatRunModeEcho({ deep: true }), "Run mode: deep");
  // Combining two flags is rejected, not silently resolved by precedence.
  assert.throws(() => formatRunModeEcho({ payments: true, admin: true }), /Choose one run mode/);
});

test("runModeHelpText documents the resolution rule and elevated-mode approval", () => {
  assert.match(runModeHelpText, /pick exactly one/i);
  assert.match(runModeHelpText, /plan's own mode is used/);
  assert.match(runModeHelpText, /approved plan/);
  assert.match(runModeHelpText, /ghost-invasion doctor/);
  // Honesty: the help must say the SAME gate applies to every mode, not imply elevated
  // modes get a uniquely stricter gate than quick (F9). The gate is mode-independent;
  // elevated modes differ only by always requiring approval.
  assert.match(runModeHelpText, /same fail-closed run gate/i);
  // The forbidden bare `ghost ` invocation must never appear in user-facing help.
  assert.equal(/(^|\s)ghost (?!-invasion|run --shard)/.test(runModeHelpText), false);
  // Every elevated mode is named in the help group.
  for (const mode of elevatedRunModes) {
    assert.ok(runModeHelpText.includes(`--${mode}`), `help text should mention --${mode}`);
  }
});

test("payments mode switches Stripe from blocked stub to localstripe", () => {
  const plan = preparePlanForRunMode(basePlan(), "payments");
  assert.equal(plan.mode, "payments");
  assert(plan.safety.mocksApplied.includes(stripeLocalstripeService));
  assert.equal(plan.safety.mocksApplied.includes(stripeBlockedStubService), false);
});

test("payments mode focuses only checkout and billing journeys", () => {
  const input = basePlan();
  input.journeys.push({
    ...input.journeys[0],
    id: "checkout-localstripe",
    name: "Checkout completes through localstripe",
    goal: "Checkout should complete against localstripe.",
    anchors: {
      routes: ["/checkout"],
      mutations: ["POST /v1/checkout/sessions"],
      surfaceHash: "sha256:checkout"
    },
    idealPath: ["apiCall:POST:{{localstripe}}/v1/checkout/sessions"]
  });

  const plan = preparePlanForRunMode(input, "payments");
  assert.deepEqual(
    plan.journeys.map((journey) => journey.id),
    ["checkout-localstripe"]
  );
});

test("permission mode expands tenant probes across roles and reads/writes", () => {
  const plan = preparePlanForRunMode(basePlan(), "permission");
  assert.equal(plan.pack, "tenant-isolation");
  assert(plan.personas.some((persona) => persona.id === "tenant-a-user"));
  assert(plan.personas.some((persona) => persona.id === "tenant-b-user"));
  assert(plan.journeys.some((journey) => journey.id === "cross-account-api-read"));
  assert(plan.journeys.some((journey) => journey.id === "cross-tenant-project-write"));
  assert(plan.journeys.every((journey) => journey.invariantsTested.includes("auth.no-cross-tenant-read")));
  assert(plan.swarm.totalBrowserSessions >= plan.journeys.length * 3);
});
