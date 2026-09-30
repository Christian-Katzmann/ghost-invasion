import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShardSpec, runSwarm } from "../dist/swarm.js";
import { RssConcurrencyWatchdog } from "../dist/rss-watchdog.js";
import { planHash } from "../dist/planner.js";
import { assertRunAllowed } from "../dist/run-gate.js";

// A hermetic env with no block-class secrets, so the run gate's live-secret scan is
// deterministic regardless of the developer/CI process environment.
const cleanEnv = {};

// Register a trusted user-owned reset boundary so a mutating run clears the safety gate.
async function writeResetConfig(projectRoot) {
  const configDir = join(projectRoot, ".ghost", "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "reset.json"),
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        strategy: "user-command",
        isolation: "user-reset",
        resetCommand: "true",
        seedCommand: null,
        runsBefore: ["mutating-swarm"],
        runsAfter: ["mutating-swarm"],
        destructiveAllowed: true,
        userOwnedBoundary: true,
        updatedAt: "2026-06-01T00:00:00.000Z"
      },
      null,
      2
    )}\n`
  );
}

// Approve a plan on disk the same way `plan --approve` does, so the gate's hash check passes.
async function approvePlanOnDisk(planPath) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  plan.approvedPlanHash = planHash(plan);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return plan.approvedPlanHash;
}

function createBuggyProjectServer() {
  let sequence = 0;
  let projects = [
    { id: "seed-a", ownerId: "user-a", name: "Seed A", notes: "", createdAt: "2026-05-30T10:00:00.000Z" }
  ];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/reset") {
      sequence = 0;
      projects = [{ id: "seed-a", ownerId: "user-a", name: "Seed A", notes: "", createdAt: "2026-05-30T10:00:00.000Z" }];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      sequence += 1;
      projects.push({
        id: `project-${sequence}`,
        ownerId: "user-a",
        name: String(body.name ?? ""),
        notes: "",
        createdAt: new Date().toISOString()
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ project: projects.at(-1) }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/projects/new") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Create project</h1>
              <form>
                <label>Project name <input aria-label="Project name" name="name" /></label>
                <button type="submit">Create</button>
              </form>
            </main>
            <script>
              const form = document.querySelector('form');
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                const name = new FormData(form).get('name');
                fetch('/api/projects', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name })
                });
              });
            </script>
          </body>
        </html>`);
      return;
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function writePlan(projectRoot, baseUrl, sessions = 1, expectedInserted = 1, overrides = {}) {
  const planDir = join(projectRoot, ".ghost", "plan");
  await mkdir(planDir, { recursive: true });
  const planPath = join(planDir, "ghost-invasion-plan.json");
  const plan = {
    $schema: "ghost-invasion/plan@1",
    createdAt: new Date().toISOString(),
    target: { baseUrl, stack: "manual", auth: "generic" },
    mode: "quick",
    pack: "launch-readiness",
    seed: 1337,
    safety: {
      targetRisk: "local",
      hardStop: false,
      egress: { mode: "container-firewall", proven: true, allowlist: ["localhost", "127.0.0.1"] },
      liveSecrets: [],
      mocksApplied: [],
      dataReset: { strategy: "user-command", isolation: "user-reset", destructiveAllowed: true },
      approvalRequired: false
    },
    swarm: {
      browserConcurrency: 2,
      browserWaves: Math.ceil(sessions / 2),
      totalBrowserSessions: sessions,
      apiTier: overrides.apiTier ?? { enabled: false, engine: "fetch", rps: 0, targets: [] },
      rateLimits: { rampMsPerContext: 750, circuitBreaker: "3%5xx|429" }
    },
    personas: [
      {
        $schema: "ghost-invasion/persona@1",
        id: "chaotic-user",
        archetype: "chaotic_user",
        role: { name: "member", authStrategy: "none", stateRef: null },
        device: { preset: "Desktop Chrome", viewport: { width: 1280, height: 800 }, touch: false, scaleFactor: 1 },
        network: { profile: "fast", downKbps: 10000, upKbps: 5000, latencyMs: 20 },
        patience: { actionTimeoutMs: 5000, maxWaitBeforeRageMs: 5000, giveUpAfterSteps: 4 },
        mistakePattern: { missThreshold: 0, doubleSubmit: false, refreshMidFlow: false, backDuringSave: false, typoRate: 0 },
        timing: { thinkTimeMs: [0, 0], typeDelayMs: [0, 0] },
        dataState: { inputProfile: "test", recordCountBefore: 0, fixtureRef: "test" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "double-click-save",
        name: "Double-click Create creates duplicates",
        goal: "Double submit should not create duplicate projects.",
        appliesToPersonas: ["chaotic-user"],
        invariantsTested: ["mutation.idempotent-create"],
        pristineRequired: true,
        anchors: { routes: ["/projects/new"], mutations: ["POST /api/projects"], surfaceHash: "sha256:test" },
        idealPath: ["goto:/projects/new", "fill:name=Launch plan", "clickRole:button:Create"],
        steps: [
          { type: "goto", url: "/projects/new" },
          { type: "fill", selector: "role=textbox[name=/project name/i]", value: "Launch plan" },
          { type: "dbSnapshot", id: "before", table: "projects", url: "/api/projects" },
          { type: "doubleSubmit", role: "button", name: "Create", gapMs: 20, cause: "ghost-injected" },
          { type: "wait", ms: 50 },
          { type: "dbSnapshot", id: "after", table: "projects", url: "/api/projects" }
        ],
        success: [
          {
            type: "expectDbDiff",
            table: "projects",
            before: "before",
            after: "after",
            where: { name: "Launch plan" },
            expectInserted: expectedInserted,
            label: "Duplicate project created on double-click"
          }
        ],
        abandon: []
      }
    ],
    surfaceHash: "sha256:test",
    approvedPlanHash: null
  };
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return planPath;
}

async function writeDiscoveredSurfaces(projectRoot) {
  const planDir = join(projectRoot, ".ghost", "plan");
  await mkdir(planDir, { recursive: true });
  const path = join(planDir, "discovered-surfaces.json");
  await writeFile(
    path,
    `${JSON.stringify(
      {
        surfaces: [
          {
            $schema: "ghost-invasion/surface@1",
            id: "test.api.projects",
            name: "Projects API",
            type: "core",
            stack: "manual",
            routes: [{ path: "/api/projects", params: [], dynamic: false }],
            methods: ["GET"],
            kind: "api",
            mutationTier: "rest",
            requiresAuth: false,
            requiresRole: [],
            isDestructive: false,
            integrations: [],
            inputs: [],
            risk: "low",
            confidence: { exists: 1 },
            evidence: [{ signal: "test", ref: "swarm.test.mjs", reliable: true }]
          },
          {
            $schema: "ghost-invasion/surface@1",
            id: "test.server-action.create",
            name: "Create action",
            type: "core",
            stack: "manual",
            routes: [{ path: "/projects/new", params: [], dynamic: false }],
            methods: ["POST"],
            kind: "server-action",
            mutationTier: "server-action",
            requiresAuth: false,
            requiresRole: [],
            isDestructive: true,
            integrations: [],
            inputs: [],
            risk: "high",
            confidence: { exists: 1 },
            evidence: [{ signal: "test", ref: "swarm.test.mjs", reliable: true }]
          }
        ]
      },
      null,
      2
    )}\n`
  );
  return path;
}

function createTenantLeakServer() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      ["GET", "PATCH"].includes(request.method ?? "") &&
      ["/projects/project-user-b-private", "/api/projects/project-user-b-private"].includes(url.pathname)
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          project: {
            id: "project-user-b-private",
            ownerId: "user-b",
            name: "Tenant B private project"
          }
        })
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function writePaymentPlan(projectRoot, baseUrl) {
  const planDir = join(projectRoot, ".ghost", "plan");
  await mkdir(planDir, { recursive: true });
  const planPath = join(planDir, "ghost-invasion-plan.json");
  const plan = {
    $schema: "ghost-invasion/plan@1",
    createdAt: new Date().toISOString(),
    target: { baseUrl, stack: "manual", auth: "generic" },
    // Approval binds to the run mode, so the on-disk plan is compiled+approved for the
    // mode it is actually run at (payments) — not the gentle quick default.
    mode: "payments",
    pack: "launch-readiness",
    seed: 1337,
    safety: {
      targetRisk: "local",
      hardStop: false,
      egress: { mode: "container-firewall", proven: true, allowlist: ["localhost", "127.0.0.1", "localstripe"] },
      liveSecrets: [],
      mocksApplied: ["stripe:blocked-stub"],
      dataReset: { strategy: "none", isolation: "unknown", destructiveAllowed: true },
      approvalRequired: true
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
        id: "checkout-user",
        archetype: "ordinary_user",
        role: { name: "member", authStrategy: "none", stateRef: null },
        device: { preset: "Desktop Chrome", viewport: { width: 1280, height: 800 }, touch: false, scaleFactor: 1 },
        network: { profile: "fast", downKbps: 10000, upKbps: 5000, latencyMs: 20 },
        patience: { actionTimeoutMs: 5000, maxWaitBeforeRageMs: 5000, giveUpAfterSteps: 4 },
        mistakePattern: { missThreshold: 0, doubleSubmit: false, refreshMidFlow: false, backDuringSave: false, typoRate: 0 },
        timing: { thinkTimeMs: [0, 0], typeDelayMs: [0, 0] },
        dataState: { inputProfile: "checkout", recordCountBefore: 0, fixtureRef: "localstripe" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "checkout-localstripe-happy-path",
        name: "Checkout payment completes through localstripe",
        goal: "Checkout creates and completes a localstripe session without touching real Stripe.",
        appliesToPersonas: ["checkout-user"],
        invariantsTested: ["data.shape-preserved"],
        pristineRequired: false,
        anchors: {
          routes: ["/checkout"],
          mutations: ["POST /v1/checkout/sessions"],
          surfaceHash: "sha256:checkout"
        },
        idealPath: ["apiCall:POST:{{localstripe}}/v1/checkout/sessions", "apiCall:POST:complete"],
        steps: [
          {
            type: "apiCall",
            method: "POST",
            url: "{{localstripe}}/v1/checkout/sessions",
            expectStatus: 200,
            body: { amount_total: 4200, currency: "usd" },
            captureResponseBody: true
          },
          {
            type: "apiCall",
            method: "POST",
            url: "{{localstripe}}/v1/checkout/sessions/cs_test_000001/complete",
            expectStatus: 200,
            captureResponseBody: true
          },
          {
            type: "apiCall",
            method: "GET",
            url: "{{localstripe}}/v1/checkout/sessions/cs_test_000001",
            expectStatus: 200,
            captureResponseBody: true
          }
        ],
        success: [{ type: "wait", ms: 0 }],
        abandon: []
      }
    ],
    surfaceHash: "sha256:checkout",
    approvedPlanHash: null
  };
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return planPath;
}

async function writeTenantLeakPlan(projectRoot, baseUrl) {
  const planDir = join(projectRoot, ".ghost", "plan");
  await mkdir(planDir, { recursive: true });
  const planPath = join(planDir, "ghost-invasion-plan.json");
  const plan = {
    $schema: "ghost-invasion/plan@1",
    createdAt: new Date().toISOString(),
    target: { baseUrl, stack: "manual", auth: "generic" },
    // Approval binds to the run mode, so the on-disk plan is compiled+approved for the
    // mode it is actually run at (permission) — not the gentle quick default.
    mode: "permission",
    pack: "launch-readiness",
    seed: 1337,
    safety: {
      targetRisk: "local",
      hardStop: false,
      egress: { mode: "container-firewall", proven: true, allowlist: ["localhost", "127.0.0.1"] },
      liveSecrets: [],
      mocksApplied: [],
      dataReset: { strategy: "user-command", isolation: "user-reset", destructiveAllowed: true },
      approvalRequired: false
    },
    swarm: {
      browserConcurrency: 3,
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
          surfaceHash: "sha256:tenant"
        },
        idealPath: ["apiCall:GET:/projects/project-user-b-private:expect404"],
        steps: [
          {
            type: "apiCall",
            method: "GET",
            url: "/projects/project-user-b-private",
            expectStatus: 404,
            captureResponseBody: true,
            ownerCheck: { expectedOwnerId: "user-a", actualOwnerId: "user-b" }
          }
        ],
        success: [{ type: "wait", ms: 0 }],
        abandon: []
      }
    ],
    surfaceHash: "sha256:tenant",
    approvedPlanHash: null
  };
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return planPath;
}

test("payments mode runs checkout against localstripe behind proven egress", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createBuggyProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePaymentPlan(cwd, baseUrl);
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath);
    const result = await runSwarm({ projectRoot: cwd, planPath, mode: "payments", workers: 1, runReset: false, env: cleanEnv });

    assert.equal(result.totals.failed, 0);
    assert.equal(result.paymentSimulation.provider, "localstripe");
    assert.equal(result.paymentSimulation.realStripeTraffic, 0);
    assert.equal(result.paymentSimulation.sessions, 1);
    const state = JSON.parse(await readFile(join(result.runRoot, "localstripe-state.json"), "utf8"));
    assert.equal(state.sessions[0].payment_status, "paid");

    const report = JSON.parse(await readFile(join(result.runRoot, "report.json"), "utf8"));
    assert(report.safety.mockedServices.includes("stripe:localstripe"));
    assert.equal(report.safety.mockedServices.includes("stripe:blocked-stub"), false);
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("payments mode refuses to run without a proven egress trap", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createBuggyProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePaymentPlan(cwd, baseUrl);
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.safety.egress.proven = false;
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, mode: "payments", workers: 1, runReset: false }),
      /requires a proven container-firewall egress trap/
    );
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("permission tenant-isolation mode confirms leaks across multiple roles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createTenantLeakServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writeTenantLeakPlan(cwd, baseUrl);
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath);
    const result = await runSwarm({
      projectRoot: cwd,
      planPath,
      mode: "permission",
      pack: "tenant-isolation",
      workers: 3,
      traceCapPerFingerprint: 1,
      reproductionBudget: 0,
      runReset: false,
      env: cleanEnv
    });

    assert(result.scale.browserSessions >= 12);
    assert(result.totals.failed >= 3);
    const report = JSON.parse(await readFile(join(result.runRoot, "report.json"), "utf8"));
    const tenantFinding = report.findings.find((finding) => finding.invariant === "auth.no-cross-tenant-read");
    assert(tenantFinding);
    assert.equal(tenantFinding.category, "confirmed-bug");
    assert.equal(tenantFinding.severity, "critical");
    assert.equal(tenantFinding.confidence, 0.95);
    assert(tenantFinding.reproducedAcross.personas >= 3);
    assert(tenantFinding.evidence.some((entry) => entry.endsWith("response-body.json")));
    assert(tenantFinding.evidence.some((entry) => entry.endsWith("db-owner-check.json")));
    assert(tenantFinding.evidence.some((entry) => entry.endsWith("trace.zip")));
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("swarm records a bad DB diff for the double-submit journey", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createBuggyProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePlan(cwd, baseUrl, 1);
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath); // every mutating run requires an approved plan
    const result = await runSwarm({ projectRoot: cwd, planPath, workers: 1, reproductionBudget: 2, runReset: false, env: cleanEnv, writeAgentMemory: true });

    assert.equal(result.pristine.total, 1);
    assert.equal(result.pristine.failed, 0);
    assert.equal(result.totals.failed, 1);
    assert.equal(result.totals.tracedFailures, 1);
    assert.equal(result.totals.orphanedChromiumProcesses, 0);
    const evidenceDirs = await readdir(join(result.runRoot, "evidence"));
    const traceDir = evidenceDirs.find((entry) => entry.endsWith(".trace"));
    assert(traceDir);
    const diff = JSON.parse(await readFile(join(result.runRoot, "evidence", traceDir, "db-diff.json"), "utf8"));
    assert.equal(diff.actualInserted, 2);
    assert.equal(diff.expectedInserted, 1);
    assert.equal(diff.pass, false);
    const report = JSON.parse(await readFile(join(result.runRoot, "report.json"), "utf8"));
    assert.equal(report.cost.actualUsd, 0);
    assert.equal(report.cost.withinBudget, true);
    assert.equal(result.cost.actualUsd, report.cost.actualUsd);
    assert.equal(report.findings[0].category, "confirmed-bug");
    assert.equal(report.findings[0].pristinePassed, true);
    assert.equal(report.findings[0].reproductionRate, "2/2 budget reruns");
    assert(report.findings[0].signals.includes("reproduction-rate:2/2"));
    assert.equal(report.findings[0].confidence, 0.93);
    assert(report.findings[0].signals.includes("db_diff_bad"));
    assert.equal(result.classification.reportMarkdown, join(result.runRoot, "report.md"));
    assert.equal(result.classification.summaryHtml, join(result.runRoot, "summary.html"));
    const markdown = await readFile(join(result.runRoot, "report.md"), "utf8");
    assert(markdown.includes("START HERE"));
    assert(markdown.indexOf("F-001") < markdown.indexOf("Folded away"));
    assert(markdown.includes("What a real user did:"));
    assert(markdown.includes("generated-tests/F-001.spec.ts"));
    const html = await readFile(join(result.runRoot, "summary.html"), "utf8");
    assert(html.includes("Ghost Invasion Summary"));
    assert(html.includes("report.json"));
    const repro = await readFile(join(result.runRoot, "reproduction-steps", "F-001.md"), "utf8");
    assert(repro.includes("1. Open /projects/new"));
    const generated = await readFile(join(result.runRoot, "generated-tests", "F-001.spec.ts"), "utf8");
    assert(generated.includes("@playwright/test"));
    assert(generated.includes("expect(matches).toHaveLength(1)"));
    const agentsMemory = await readFile(join(cwd, "AGENTS.md"), "utf8");
    assert(agentsMemory.includes("safe_base_url:"));
    assert(agentsMemory.includes("success_criteria: double-click-save: projects inserts 1"));
    const claudeMemory = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    assert(claudeMemory.includes("@AGENTS.md"));
    assert.equal(result.memory?.updatedPath, join(cwd, "AGENTS.md"));

    const laterRun = await runSwarm({ projectRoot: cwd, planPath, dryRun: true, runReset: false });
    assert(laterRun.memory?.factsRead > 0);
    assert(laterRun.memory?.keys.includes("safe_base_url"));
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("budget-usd zero replays the committed plan with no paid phases", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createBuggyProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePlan(cwd, baseUrl, 1);
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath); // every mutating run requires an approved plan
    const result = await runSwarm({
      projectRoot: cwd,
      planPath,
      workers: 1,
      budgetUsd: 0,
      reproductionBudget: 0,
      runReset: false,
      env: cleanEnv
    });

    await assert.rejects(readFile(join(cwd, "AGENTS.md")), { code: "ENOENT" });
    await assert.rejects(readFile(join(cwd, "CLAUDE.md")), { code: "ENOENT" });
    assert.equal(result.memory?.updatedPath, undefined);
    assert.equal(result.cost.budgetUsd, 0);
    assert.equal(result.cost.actualUsd, 0);
    assert(result.cost.degradations.includes("llm-phases-skipped:replay-committed-plan"));
    assert.equal(result.cost.phases.find((phase) => phase.name === "plan").skipped, true);
    assert.equal(result.cost.phases.find((phase) => phase.name === "classify").actualUsd, 0);

    const report = JSON.parse(await readFile(join(result.runRoot, "report.json"), "utf8"));
    assert.equal(report.cost.budgetUsd, 0);
    assert.equal(report.cost.actualUsd, 0);
    assert.equal(report.cost.withinBudget, true);
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("pristine sentinel quarantines a mis-authored journey", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createBuggyProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePlan(cwd, baseUrl, 1, 3);
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath); // every mutating run requires an approved plan
    const result = await runSwarm({ projectRoot: cwd, planPath, workers: 1, runReset: false, env: cleanEnv });

    assert.equal(result.pristine.total, 1);
    assert.equal(result.pristine.failed, 1);
    const report = JSON.parse(await readFile(join(result.runRoot, "report.json"), "utf8"));
    assert.equal(report.findings[0].category, "needs-human-review");
    assert.equal(report.findings[0].pristinePassed, false);
    assert(report.findings[0].confidence <= 0.6);
    assert(report.findings[0].signals.includes("ceiling:pristine-failed"));
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("per-fingerprint trace cap limits a 200-session repeated failure run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createBuggyProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePlan(cwd, baseUrl, 200);
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath); // every mutating run requires an approved plan
    const result = await runSwarm({
      projectRoot: cwd,
      planPath,
      workers: 4,
      sessions: 200,
      traceCapPerFingerprint: 3,
      runReset: false,
      env: cleanEnv
    });

    assert.equal(result.totals.failed, 200);
    assert.equal(result.totals.tracedFailures, 3);
    assert.equal(result.totals.traceSkippedByCap, 197);
    assert.equal(Object.values(result.evidence.traceReservations)[0], 3);
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("API tier counts total REST requests instead of unique endpoints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  const app = createBuggyProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePlan(cwd, baseUrl, 1, 1, {
      apiTier: { enabled: true, engine: "fetch", rps: 0, targets: ["rest", "server-action:false", "form-post:false"] }
    });
    await writeDiscoveredSurfaces(cwd);
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath); // every mutating run requires an approved plan

    const result = await runSwarm({
      projectRoot: cwd,
      planPath,
      workers: 1,
      apiRequestBudget: 4,
      reproductionBudget: 0,
      runReset: false,
      env: cleanEnv
    });

    assert.equal(result.apiTier.enabled, true);
    assert.equal(result.apiTier.requests, 4);
    assert.equal(result.apiTier.endpointsHit, 1);
    assert.equal(result.scale.apiRequests, 4);
    assert.equal(result.scale.apiEndpointsHit, 1);
    assert(result.apiTier.targets.every((target) => target.surfaceId === "test.api.projects"));
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("shard k/n selects a stable slice and writes shard-safe run ids", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-swarm-"));
  try {
    const planPath = await writePlan(cwd, "http://127.0.0.1:9", 10);
    const shard = parseShardSpec("2/4");
    const result = await runSwarm({ projectRoot: cwd, planPath, shard, dryRun: true, runReset: false });

    assert.deepEqual(shard, { index: 2, total: 4 });
    assert.equal(result.shard.index, 2);
    assert.equal(result.shard.total, 4);
    assert.equal(result.scale.browserSessions, 3);
    assert(result.runId.endsWith(".shard-2-of-4"));
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("RSS watchdog sheds concurrency under induced memory pressure", async () => {
  const shedEvents = [];
  const watchdog = new RssConcurrencyWatchdog({
    initialConcurrency: 8,
    maxRssMb: 100,
    minConcurrency: 2,
    readRssMb: async () => 250,
    onShed: (event) => shedEvents.push(event)
  });

  await watchdog.sampleOnce();
  assert.equal(watchdog.limit, 4);
  await watchdog.sampleOnce();
  assert.equal(watchdog.limit, 3);
  assert.equal(shedEvents.length, 2);
  assert.equal(watchdog.snapshot().lastRssMb, 250);
});

// --- Run-path safety gate (batch 01-run-path-gate) -------------------------------
// Each case proves the pre-run gate fails closed before any drone/BrowserPool starts.
// All would resolve (not reject) on the pre-fix code, where runSwarm never re-evaluated
// the verdict — so each asserts a gate-specific message a connection error never carries.

// Assert that a blocked run never produced a drone's DB diff anywhere under the project.
async function assertNoDbDiffWritten(projectRoot) {
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === "db-diff.json") {
        assert.fail(`unexpected db-diff written before the gate: ${full}`);
      }
    }
  }
  await walk(join(projectRoot, ".ghost"));
}

test("run gate blocks a production target and clears it only with the flag", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    const planPath = await writePlan(cwd, "https://app.example.com");
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath);

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, workers: 1, runReset: false, env: cleanEnv }),
      /run blocked by safety verdict.*production/s
    );
    await assertNoDbDiffWritten(cwd);

    // The same plan passes the gate once the operator opts into the production target.
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const gate = await assertRunAllowed({
      loadedPlan: plan,
      projectRoot: cwd,
      baseUrl: plan.target.baseUrl,
      mode: "quick",
      reset: { strategy: "user-command", isolation: "user-reset" },
      allowProductionTarget: true,
      env: cleanEnv
    });
    assert.notEqual(gate.verdict.verdict, "block");
    assert.equal(gate.verdict.flags.allowProductionTarget, true);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("run gate blocks a live block-class secret in the environment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    const planPath = await writePlan(cwd, "http://127.0.0.1:9");
    await writeResetConfig(cwd);

    await assert.rejects(
      () =>
        runSwarm({
          projectRoot: cwd,
          planPath,
          workers: 1,
          runReset: false,
          env: { STRIPE_SECRET_KEY: "sk_live_0123456789abcdef" }
        }),
      /run blocked by safety verdict.*dangerous environment/s
    );
    await assertNoDbDiffWritten(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("run gate blocks a mutating run with no reset boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    // No writeResetConfig: the registered reset boundary is absent.
    const planPath = await writePlan(cwd, "http://127.0.0.1:9");

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, workers: 1, runReset: false, env: cleanEnv }),
      /run blocked by safety verdict.*reset\/isolation/s
    );
    await assertNoDbDiffWritten(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("run gate still gates a target sourced from AGENTS.md safe_base_url", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    // Empty plan target forces runSwarm to fall back to the agent-memory safe_base_url.
    const planPath = await writePlan(cwd, "http://127.0.0.1:9");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.target.baseUrl = "";
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    await writeResetConfig(cwd);
    await writeFile(
      join(cwd, "AGENTS.md"),
      [
        "# AGENTS.md",
        "",
        "<!-- ghost-invasion-memory:start -->",
        "- safe_base_url: https://app.example.com",
        "<!-- ghost-invasion-memory:end -->",
        ""
      ].join("\n")
    );

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, workers: 1, runReset: false, env: cleanEnv }),
      /run blocked by safety verdict.*production/s
    );
    await assertNoDbDiffWritten(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("run gate blocks an unapproved approval-required (deep) plan", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    const planPath = await writePlan(cwd, "http://127.0.0.1:9");
    await writeResetConfig(cwd);
    // No approvePlanOnDisk: approvedPlanHash stays null.

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, mode: "deep", workers: 1, runReset: false, env: cleanEnv }),
      /run blocked by safety verdict.*plan approval is required/s
    );
    await assertNoDbDiffWritten(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("run gate blocks a deep plan that was edited after approval", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    const planPath = await writePlan(cwd, "http://127.0.0.1:9");
    await writeResetConfig(cwd);
    await approvePlanOnDisk(planPath);

    // Tamper a field that changes the hash but not the verdict, after approval.
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.seed = 9999;
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, mode: "deep", workers: 1, runReset: false, env: cleanEnv }),
      /run blocked: plan approval hash does not match/
    );
    await assertNoDbDiffWritten(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("run gate rejects a malformed plan before any use", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    const planDir = join(cwd, ".ghost", "plan");
    await mkdir(planDir, { recursive: true });
    const planPath = join(planDir, "ghost-invasion-plan.json");
    // Valid JSON, invalid plan: missing every required field except $schema.
    await writeFile(planPath, `${JSON.stringify({ $schema: "ghost-invasion/plan@1" }, null, 2)}\n`);

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, workers: 1, runReset: false, env: cleanEnv }),
      /plan failed ghostPlanSchema validation/
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

// --- batch 01-gate-mode-binding regressions (F1, F5) ------------------------------
// F1: approval must bind to the mode that actually runs. A plan approved as the gentle
// `quick` mode must NOT be runnable at an elevated mode without re-approval — the human
// approved an intensity of run, and the runner rewrites the mode (preparePlanForRunMode)
// while the on-disk hash still matches the quick plan, so the pre-fix gate let the
// escalation ride through. On current code each escalated run passes the gate and then
// fails on the dead port with a connection error (not the gate's mode message), so this
// case FAILS pre-fix and only passes once the gate binds approval to the run mode.
test("run gate blocks a quick-approved plan escalated to an elevated mode", async () => {
  for (const elevatedMode of ["deep", "chaos", "permission", "concurrency"]) {
    const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
    try {
      const planPath = await writePlan(cwd, "http://127.0.0.1:9");
      await writeResetConfig(cwd);
      await approvePlanOnDisk(planPath); // approved as the default quick mode

      await assert.rejects(
        () => runSwarm({ projectRoot: cwd, planPath, mode: elevatedMode, workers: 1, runReset: false, env: cleanEnv }),
        /run blocked: .*re-approve at this mode/,
        `escalation to ${elevatedMode} should be blocked`
      );
      await assertNoDbDiffWritten(cwd);
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  }
});

// F5: the hash/approval check must run on EVERY mutating run, not be skipped on the
// quick-local path. Otherwise a hand-edited `egress.proven:true` on an unapproved plan
// rides through the egress requirement with no live canary. On current code the quick
// path skips the check, so the run reaches the dead port and rejects with a connection
// error (not the approval message); this case only passes once the gate requires a valid
// approval before any mutating run.
test("run gate blocks an unapproved mutating run so a forged egress.proven cannot ride through", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-gate-"));
  try {
    const planPath = await writePlan(cwd, "http://127.0.0.1:9");
    await writeResetConfig(cwd);
    // Forge the egress proof on an UNAPPROVED plan: claim the trap is proven without a
    // canary, and leave approvedPlanHash null so nothing signs the claim.
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.safety.egress.proven = true;
    plan.approvedPlanHash = null;
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);

    await assert.rejects(
      () => runSwarm({ projectRoot: cwd, planPath, workers: 1, runReset: false, env: cleanEnv }),
      /run blocked: .*requires an approved plan/
    );
    await assertNoDbDiffWritten(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});
