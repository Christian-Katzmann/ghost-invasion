import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRun } from "../dist/classifier.js";
import { renderDemoReport } from "../dist/reporter.js";
import {
  applyRiskPackToPlan,
  attachInvariantsToSurfaces,
  defaultInvariantLedger,
  listRiskPacks,
  loadRiskPack,
  writeDefaultInvariantLedger
} from "../dist/contracts.js";

function projectSurface(overrides = {}) {
  return {
    $schema: "ghost-invasion/surface@1",
    id: "core.projects.show",
    name: "Show project",
    type: "core",
    stack: "sveltekit",
    routes: [{ path: "/projects/[id]", params: ["id"], dynamic: true }],
    methods: ["GET"],
    kind: "page",
    mutationTier: "browser-only",
    requiresAuth: true,
    requiresRole: ["member"],
    isDestructive: false,
    integrations: [],
    inputs: [],
    risk: "critical",
    confidence: { exists: 1, requiresAuth: 1 },
    evidence: [{ signal: "filesystem", ref: "src/routes/projects/[id]/+page.server.ts", reliable: true }],
    ...overrides
  };
}

function basePlan(pack = "auth-boundaries") {
  return {
    $schema: "ghost-invasion/plan@1",
    createdAt: "2026-05-31T08:00:00Z",
    target: { baseUrl: "http://127.0.0.1:5173", stack: "sveltekit", auth: "generic" },
    mode: "quick",
    pack,
    seed: 1337,
    safety: {
      targetRisk: "local",
      hardStop: false,
      egress: { mode: "attach-only", proven: false, allowlist: ["localhost", "127.0.0.1"] },
      liveSecrets: [],
      mocksApplied: [],
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
        archetype: "permission_boundary",
        role: { name: "member", authStrategy: "storage-state", stateRef: null },
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
        name: "Cross-tenant project read",
        goal: "A member must not read another user's project by changing the id in the URL.",
        appliesToPersonas: ["permission-boundary-user"],
        invariantsTested: [],
        pristineRequired: true,
        anchors: { routes: ["/projects/[id]"], mutations: ["GET /projects/[id]"], surfaceHash: "sha256:test" },
        idealPath: ["goto:/projects/other-user-project"],
        steps: [{ type: "goto", url: "/projects/other-user-project" }],
        success: [{ type: "expectHidden", selector: "text=/user b private/i" }],
        abandon: []
      }
    ],
    surfaceHash: "sha256:test",
    approvedPlanHash: null
  };
}

function shapePlan() {
  const plan = basePlan("data-shapes");
  return {
    ...plan,
    personas: [
      {
        ...plan.personas[0],
        id: "power-user",
        archetype: "power_user",
        dataState: { inputProfile: "rich-input", recordCountBefore: 1, fixtureRef: "rich-input-fixture" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "unicode-rich-input-roundtrip",
        name: "Unicode rich input keeps its data shape",
        goal: "Required rich fields roundtrip without silent coercion or loss.",
        appliesToPersonas: ["power-user"],
        invariantsTested: ["data.shape-preserved"],
        pristineRequired: true,
        anchors: { routes: ["/settings/profile"], mutations: ["PATCH /api/profile"], surfaceHash: "sha256:test" },
        idealPath: ["goto:/settings/profile", "fill:displayName=Aasa & Co", "clickRole:button:Save"],
        steps: [
          { type: "goto", url: "/settings/profile" },
          { type: "fill", selector: "role=textbox[name=/display name/i]", value: "Aasa & Co" },
          { type: "dbSnapshot", id: "before", table: "profiles", url: "/api/profile" },
          { type: "apiCall", method: "PATCH", url: "/api/profile", expectStatus: 200, body: { displayName: "Aasa & Co" } },
          { type: "dbSnapshot", id: "after", table: "profiles", url: "/api/profile" }
        ],
        success: [{ type: "expectText", selector: "body", text: "Aasa & Co" }],
        abandon: []
      }
    ]
  };
}

function mobileFirstRunPlan() {
  const plan = basePlan("mobile-first-run");
  return {
    ...plan,
    personas: [
      {
        ...plan.personas[0],
        id: "mobile-new-user",
        archetype: "mobile_new_user",
        device: { preset: "Mobile Safari", viewport: { width: 390, height: 844 }, touch: true, scaleFactor: 3 },
        dataState: { inputProfile: "first-run", recordCountBefore: 0, fixtureRef: "mobile-onboarding" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "mobile-first-run",
        name: "Mobile first-run onboarding completes",
        goal: "Mobile first-run onboarding reaches the project list.",
        appliesToPersonas: ["mobile-new-user"],
        invariantsTested: [],
        pristineRequired: true,
        anchors: { routes: ["/welcome"], mutations: [], surfaceHash: "sha256:test" },
        idealPath: ["goto:/welcome", "clickRole:button:Get started"],
        steps: [
          { type: "goto", url: "/welcome" },
          { type: "clickRole", role: "button", name: "Get started" }
        ],
        success: [{ type: "expectText", selector: "body", text: "Projects" }],
        abandon: []
      }
    ]
  };
}

function multiTabPlan() {
  const plan = basePlan("multi-tab");
  return {
    ...plan,
    personas: [
      {
        ...plan.personas[0],
        id: "multi-tab-user",
        archetype: "power_user",
        dataState: { inputProfile: "stale-form", recordCountBefore: 1, fixtureRef: "project-settings" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "stale-tab-submit",
        name: "Stale tab submit preserves newer settings",
        goal: "A stale tab must not overwrite newer project settings.",
        appliesToPersonas: ["multi-tab-user"],
        invariantsTested: [],
        pristineRequired: true,
        anchors: { routes: ["/projects/[id]/settings"], mutations: ["PATCH /api/projects/[id]"], surfaceHash: "sha256:test" },
        idealPath: ["goto:/projects/p-1/settings", "newTab:/projects/p-1/settings", "fill:title=Fresh title"],
        steps: [
          { type: "goto", url: "/projects/p-1/settings" },
          { type: "dbSnapshot", id: "before", table: "projects", url: "/api/projects" },
          { type: "fill", selector: "role=textbox[name=/title/i]", value: "Stale title" },
          { type: "apiCall", method: "PATCH", url: "/api/projects/p-1", expectStatus: 200, body: { title: "Stale title" } },
          { type: "dbSnapshot", id: "after", table: "projects", url: "/api/projects" }
        ],
        success: [{ type: "expectDbDiff", table: "projects", before: "before", after: "after", where: { id: "p-1" }, expectInserted: 0 }],
        abandon: []
      }
    ]
  };
}

test("auth-boundaries auto-attaches the cross-tenant invariant to Projectly owned-resource surfaces", async () => {
  const pack = await loadRiskPack("auth-boundaries");
  const attached = attachInvariantsToSurfaces([projectSurface()], defaultInvariantLedger, pack);

  assert.deepEqual(
    attached["core.projects.show"].map((item) => item.invariantId),
    ["auth.no-cross-tenant-read"]
  );
});

test("risk packs are data files that add their invariants to matching journeys", async () => {
  const pack = await loadRiskPack("auth-boundaries");
  const plan = applyRiskPackToPlan(basePlan(), pack, defaultInvariantLedger);

  assert.equal(plan.pack, "auth-boundaries");
  assert.deepEqual(plan.journeys[0].invariantsTested, ["auth.no-cross-tenant-read"]);
});

test("the full bundled risk-pack library is discoverable and loadable", async () => {
  const packs = await listRiskPacks();
  const expected = [
    "auth-boundaries",
    "data-shapes",
    "idempotency",
    "launch-readiness",
    "mobile-first-run",
    "multi-tab",
    "tenant-isolation"
  ];

  assert.deepEqual(packs, expected);
  for (const id of expected) {
    const pack = await loadRiskPack(id);
    assert.equal(pack.id, id);
    assert(pack.invariants.length > 0);
    assert(pack.personas.length > 0);
    assert(pack.journeys.length > 0);
    assert(pack.evidenceRules.length > 0);
  }
});

test("new packs auto-attach only their own invariant families to matching surfaces", async () => {
  const createSurface = projectSurface({
    id: "core.projects.create",
    name: "Create project",
    routes: [{ path: "/projects/new", params: [], dynamic: false }],
    methods: ["POST"],
    kind: "api",
    mutationTier: "rest",
    inputs: [{ name: "name", type: "text", required: true, source: "body" }]
  });
  const mobileSurface = projectSurface({
    id: "core.onboarding.welcome",
    name: "Mobile onboarding welcome",
    routes: [{ path: "/welcome", params: [], dynamic: false }],
    methods: ["GET"],
    requiresAuth: false,
    requiresRole: []
  });
  const multiTabSurface = projectSurface({
    id: "core.projects.settings",
    name: "Edit project settings",
    routes: [{ path: "/projects/[id]/settings", params: ["id"], dynamic: true }],
    methods: ["PATCH"],
    kind: "mutation",
    mutationTier: "rest",
    inputs: [{ name: "title", type: "text", required: true, source: "form" }]
  });
  const dataShapeSurface = projectSurface({
    id: "core.profile.form",
    name: "Profile form",
    routes: [{ path: "/settings/profile", params: [], dynamic: false }],
    methods: ["PATCH"],
    kind: "api",
    mutationTier: "rest",
    inputs: [{ name: "displayName", type: "text", required: true, source: "body" }]
  });

  const idempotency = attachInvariantsToSurfaces([createSurface], defaultInvariantLedger, await loadRiskPack("idempotency"));
  assert.deepEqual(
    idempotency["core.projects.create"].map((item) => item.invariantId),
    ["mutation.idempotent-create"]
  );

  const mobile = attachInvariantsToSurfaces([mobileSurface], defaultInvariantLedger, await loadRiskPack("mobile-first-run"));
  assert.deepEqual(
    mobile["core.onboarding.welcome"].map((item) => item.invariantId),
    ["ux.no-dead-end-after-error", "ux.mobile-first-run-completes"]
  );

  const multiTab = attachInvariantsToSurfaces([multiTabSurface], defaultInvariantLedger, await loadRiskPack("multi-tab"));
  assert.deepEqual(
    multiTab["core.projects.settings"].map((item) => item.invariantId),
    ["mutation.multi-tab-consistency"]
  );

  const dataShapes = attachInvariantsToSurfaces([dataShapeSurface], defaultInvariantLedger, await loadRiskPack("data-shapes"));
  assert.deepEqual(
    dataShapes["core.profile.form"].map((item) => item.invariantId),
    ["data.shape-preserved"]
  );
});

test("data-shapes pack confirms a planted data-shape defect without double-counting overlaps", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-contracts-"));
  const runRoot = join(cwd, ".ghost", "runs", "shape-run");
  const droneId = "power-user.unicode-rich-input-roundtrip.01337";
  const evidenceDir = join(runRoot, "evidence", `${droneId}.trace`);
  await mkdir(evidenceDir, { recursive: true });
  await writeDefaultInvariantLedger(cwd);
  await writeFile(join(evidenceDir, "trace.zip"), "fake trace");
  await writeFile(join(evidenceDir, "response-body.json"), JSON.stringify({ profile: { displayName: "Asa" } }));
  await writeFile(
    join(evidenceDir, "db-diff.json"),
    JSON.stringify({ table: "profiles", expectedInserted: 0, actualInserted: 0, pass: false })
  );

  try {
    const plan = applyRiskPackToPlan(shapePlan(), await loadRiskPack("data-shapes"), defaultInvariantLedger);
    assert.deepEqual(plan.journeys[0].invariantsTested, ["data.shape-preserved"]);

    const result = await classifyRun({
      projectRoot: cwd,
      plan,
      swarmSummary: {
        runId: "shape-run",
        runRoot,
        status: "completed",
        target: "http://127.0.0.1:5173",
        scale: { browserSessions: 1, browserConcurrency: 1, browserWaves: 1, apiRequests: 0, apiEndpointsHit: 0 },
        failures: [
          {
            droneId,
            journeyId: "unicode-rich-input-roundtrip",
            personaId: "power-user",
            seed: 1337,
            message: "Unicode display name was coerced during profile save.",
            fingerprint: "data-shape-loss"
          }
        ]
      },
      pristineResults: [{ journeyId: "unicode-rich-input-roundtrip", ok: true, droneId: "pristine.unicode-rich-input-roundtrip.01337" }]
    });

    const finding = result.report.findings[0];
    assert.equal(finding.category, "confirmed-bug");
    assert.equal(finding.severity, "high");
    assert.equal(finding.invariant, "data.shape-preserved");
    assert.equal(result.report.totals.findings, 1);
    assert(!finding.signals.some((signal) => signal.startsWith("ceiling:")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mobile-first-run pack fires on a planted mobile first-run defect", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-contracts-"));
  const runRoot = join(cwd, ".ghost", "runs", "mobile-run");
  const droneId = "mobile-new-user.mobile-first-run.01337";
  const evidenceDir = join(runRoot, "evidence", `${droneId}.trace`);
  await mkdir(evidenceDir, { recursive: true });
  await writeDefaultInvariantLedger(cwd);
  await writeFile(join(evidenceDir, "trace.zip"), "fake trace");
  await writeFile(join(evidenceDir, "fail.png"), "fake screenshot");

  try {
    const plan = applyRiskPackToPlan(mobileFirstRunPlan(), await loadRiskPack("mobile-first-run"), defaultInvariantLedger);
    assert.equal(plan.pack, "mobile-first-run");
    assert.deepEqual(plan.journeys[0].invariantsTested, ["ux.mobile-first-run-completes"]);

    const result = await classifyRun({
      projectRoot: cwd,
      plan,
      swarmSummary: {
        runId: "mobile-run",
        runRoot,
        status: "completed",
        target: "http://127.0.0.1:5173",
        scale: { browserSessions: 1, browserConcurrency: 1, browserWaves: 1, apiRequests: 0, apiEndpointsHit: 0 },
        failures: [
          {
            droneId,
            journeyId: "mobile-first-run",
            personaId: "mobile-new-user",
            seed: 1337,
            message: "Mobile onboarding never reached the project list.",
            fingerprint: "mobile-first-run-stall"
          }
        ]
      },
      pristineResults: [{ journeyId: "mobile-first-run", ok: true, droneId: "pristine.mobile-first-run.01337" }]
    });

    const finding = result.report.findings[0];
    assert.equal(finding.invariant, "ux.mobile-first-run-completes");
    assert.equal(finding.severity, "medium");
    assert.equal(result.report.totals.findings, 1);
    assert(finding.evidence.some((entry) => entry.endsWith("fail.png")));
    assert(finding.signals.includes("ceiling:soft-invariant"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("multi-tab pack confirms a planted stale-tab defect without double-counting overlaps", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-contracts-"));
  const runRoot = join(cwd, ".ghost", "runs", "multi-tab-run");
  const droneId = "multi-tab-user.stale-tab-submit.01337";
  const evidenceDir = join(runRoot, "evidence", `${droneId}.trace`);
  await mkdir(evidenceDir, { recursive: true });
  await writeDefaultInvariantLedger(cwd);
  await writeFile(join(evidenceDir, "trace.zip"), "fake trace");
  await writeFile(
    join(evidenceDir, "db-diff.json"),
    JSON.stringify({ table: "projects", expectedInserted: 0, actualInserted: 1, pass: false })
  );

  try {
    const plan = applyRiskPackToPlan(multiTabPlan(), await loadRiskPack("multi-tab"), defaultInvariantLedger);
    assert.equal(plan.pack, "multi-tab");
    assert.deepEqual(plan.journeys[0].invariantsTested, ["mutation.multi-tab-consistency"]);

    const result = await classifyRun({
      projectRoot: cwd,
      plan,
      swarmSummary: {
        runId: "multi-tab-run",
        runRoot,
        status: "completed",
        target: "http://127.0.0.1:5173",
        scale: { browserSessions: 1, browserConcurrency: 1, browserWaves: 1, apiRequests: 0, apiEndpointsHit: 0 },
        failures: [
          {
            droneId,
            journeyId: "stale-tab-submit",
            personaId: "multi-tab-user",
            seed: 1337,
            message: "A stale tab overwrote newer project settings.",
            fingerprint: "multi-tab-stale-overwrite"
          }
        ]
      },
      pristineResults: [{ journeyId: "stale-tab-submit", ok: true, droneId: "pristine.stale-tab-submit.01337" }]
    });

    const finding = result.report.findings[0];
    assert.equal(finding.category, "confirmed-bug");
    assert.equal(finding.severity, "high");
    assert.equal(finding.invariant, "mutation.multi-tab-consistency");
    assert.equal(result.report.totals.findings, 1);
    assert(finding.evidence.some((entry) => entry.endsWith("db-diff.json")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tenant-isolation pack confirms a planted tenant leak when required evidence is present", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-contracts-"));
  const runRoot = join(cwd, ".ghost", "runs", "tenant-run");
  const droneId = "permission-boundary-user.cross-tenant-project-read.01337";
  const evidenceDir = join(runRoot, "evidence", `${droneId}.trace`);
  await mkdir(evidenceDir, { recursive: true });
  await writeDefaultInvariantLedger(cwd);
  await writeFile(join(evidenceDir, "trace.zip"), "fake trace");
  await writeFile(join(evidenceDir, "response-body.json"), JSON.stringify({ project: { id: "project-b", ownerId: "user-b" } }));
  await writeFile(join(evidenceDir, "db-owner-check.json"), JSON.stringify({ expectedOwnerId: "user-a", actualOwnerId: "user-b" }));

  try {
    const plan = applyRiskPackToPlan(basePlan("tenant-isolation"), await loadRiskPack("tenant-isolation"), defaultInvariantLedger);
    assert.equal(plan.pack, "tenant-isolation");
    assert.deepEqual(plan.journeys[0].invariantsTested, ["auth.no-cross-tenant-read"]);

    const result = await classifyRun({
      projectRoot: cwd,
      plan,
      swarmSummary: {
        runId: "tenant-run",
        runRoot,
        status: "completed",
        target: "http://127.0.0.1:5173",
        scale: { browserSessions: 1, browserConcurrency: 1, browserWaves: 1, apiRequests: 0, apiEndpointsHit: 0 },
        failures: [
          {
            droneId,
            journeyId: "cross-tenant-project-read",
            personaId: "permission-boundary-user",
            seed: 1337,
            message: "A user saw a project owned by another tenant.",
            fingerprint: "tenant-leak"
          }
        ]
      },
      pristineResults: [{ journeyId: "cross-tenant-project-read", ok: true, droneId: "pristine.cross-tenant-project-read.01337" }]
    });

    const finding = result.report.findings[0];
    assert.equal(finding.category, "confirmed-bug");
    assert.equal(finding.severity, "critical");
    assert.equal(finding.invariant, "auth.no-cross-tenant-read");
    assert.equal(finding.confidence, 0.95);
    assert.equal(finding.title, "A user can read another tenant's private project");
    assert(finding.evidence.some((entry) => entry.endsWith("response-body.json")));
    assert(finding.evidence.some((entry) => entry.endsWith("db-owner-check.json")));
    assert(finding.evidence.some((entry) => entry.endsWith("trace.zip")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a tenant-leak journey proven only by a trace does not assert the cross-tenant-read story", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-contracts-"));
  const runRoot = join(cwd, ".ghost", "runs", "tenant-trace-only-run");
  const droneId = "permission-boundary-user.cross-tenant-project-read.01337";
  const evidenceDir = join(runRoot, "evidence", `${droneId}.trace`);
  await mkdir(evidenceDir, { recursive: true });
  await writeDefaultInvariantLedger(cwd);
  // Only a trace is captured: the owner-check artifact that would prove a cross-tenant
  // read is absent, so the narrative must not assert that story (S-015).
  await writeFile(join(evidenceDir, "trace.zip"), "fake trace");

  try {
    const plan = applyRiskPackToPlan(basePlan("tenant-isolation"), await loadRiskPack("tenant-isolation"), defaultInvariantLedger);

    const result = await classifyRun({
      projectRoot: cwd,
      plan,
      swarmSummary: {
        runId: "tenant-trace-only-run",
        runRoot,
        status: "completed",
        target: "http://127.0.0.1:5173",
        scale: { browserSessions: 1, browserConcurrency: 1, browserWaves: 1, apiRequests: 0, apiEndpointsHit: 0 },
        failures: [
          {
            droneId,
            journeyId: "cross-tenant-project-read",
            personaId: "permission-boundary-user",
            seed: 1337,
            message: "Tenant journey failed before the owner-check artifact was captured.",
            fingerprint: "tenant-leak-trace-only"
          }
        ]
      },
      pristineResults: [{ journeyId: "cross-tenant-project-read", ok: true, droneId: "pristine.cross-tenant-project-read.01337" }]
    });

    const finding = result.report.findings[0];
    assert(!finding.title.toLowerCase().includes("another tenant"));
    assert.notEqual(finding.category, "confirmed-bug");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("--demo-report labels every rendered surface as synthetic", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-contracts-"));
  try {
    const result = await renderDemoReport({ projectRoot: cwd });
    assert.equal(result.demoReport, true);

    const markdown = await readFile(result.artifacts.reportMarkdown, "utf8");
    const html = await readFile(result.artifacts.summaryHtml, "utf8");
    assert(markdown.includes("SYNTHETIC DEMO REPORT"));
    assert(html.includes("SYNTHETIC DEMO REPORT"));
    assert(html.includes("synthetic-banner"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function twoFindingPlan() {
  const plan = basePlan("launch-readiness");
  return {
    ...plan,
    personas: [plan.personas[0], { ...plan.personas[0], id: "chaotic-user", archetype: "impatient_user" }],
    journeys: [
      { ...plan.journeys[0], invariantsTested: ["auth.no-cross-tenant-read"] },
      {
        $schema: "ghost-invasion/journey@1",
        id: "double-click-save",
        name: "Double-click Create creates duplicates",
        goal: "Impatient user double-clicks Create; the app must not create two projects.",
        appliesToPersonas: ["chaotic-user"],
        invariantsTested: ["mutation.idempotent-create"],
        pristineRequired: true,
        anchors: { routes: ["/projects/new"], mutations: ["POST /projects/new"], surfaceHash: "sha256:test" },
        idealPath: ["goto:/projects/new"],
        steps: [{ type: "goto", url: "/projects/new" }],
        success: [],
        abandon: []
      }
    ]
  };
}

test("finding ids are stable regardless of the order drones failed in (same seed, concurrency >= 2)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-contracts-"));
  const runRoot = join(cwd, ".ghost", "runs", "id-stability-run");
  const tenantDrone = "permission-boundary-user.cross-tenant-project-read.01337";
  const doubleDrone = "chaotic-user.double-click-save.01337";
  await mkdir(join(runRoot, "evidence", `${tenantDrone}.trace`), { recursive: true });
  await mkdir(join(runRoot, "evidence", `${doubleDrone}.trace`), { recursive: true });
  await writeDefaultInvariantLedger(cwd);
  await writeFile(join(runRoot, "evidence", `${tenantDrone}.trace`, "trace.zip"), "fake trace");
  await writeFile(
    join(runRoot, "evidence", `${tenantDrone}.trace`, "response-body.json"),
    JSON.stringify({ project: { id: "project-b", ownerId: "user-b" } })
  );
  await writeFile(
    join(runRoot, "evidence", `${tenantDrone}.trace`, "db-owner-check.json"),
    JSON.stringify({ expectedOwnerId: "user-a", actualOwnerId: "user-b" })
  );
  await writeFile(join(runRoot, "evidence", `${doubleDrone}.trace`, "trace.zip"), "fake trace");
  await writeFile(
    join(runRoot, "evidence", `${doubleDrone}.trace`, "db-diff.json"),
    JSON.stringify({ table: "projects", expectedInserted: 1, actualInserted: 2, pass: false })
  );

  const tenantFailure = {
    droneId: tenantDrone,
    journeyId: "cross-tenant-project-read",
    personaId: "permission-boundary-user",
    seed: 1337,
    message: "A user saw a project owned by another tenant.",
    fingerprint: "tenant-leak"
  };
  const doubleFailure = {
    droneId: doubleDrone,
    journeyId: "double-click-save",
    personaId: "chaotic-user",
    seed: 1337,
    message: "Double-click created a duplicate project.",
    fingerprint: "double-click-dup"
  };
  const pristineResults = [
    { journeyId: "cross-tenant-project-read", ok: true, droneId: "pristine.cross-tenant-project-read.01337" },
    { journeyId: "double-click-save", ok: true, droneId: "pristine.double-click-save.01337" }
  ];

  function classify(failures) {
    return classifyRun({
      projectRoot: cwd,
      plan: twoFindingPlan(),
      swarmSummary: {
        runId: "id-stability-run",
        runRoot,
        status: "completed",
        target: "http://127.0.0.1:5173",
        scale: { browserSessions: 2, browserConcurrency: 2, browserWaves: 1, apiRequests: 0, apiEndpointsHit: 0 },
        failures
      },
      pristineResults
    });
  }

  try {
    const forward = await classify([tenantFailure, doubleFailure]);
    const reversed = await classify([doubleFailure, tenantFailure]);

    const idFor = (report, invariant) => report.findings.find((finding) => finding.invariant === invariant)?.id;
    assert.equal(idFor(forward.report, "mutation.idempotent-create"), idFor(reversed.report, "mutation.idempotent-create"));
    assert.equal(idFor(forward.report, "auth.no-cross-tenant-read"), idFor(reversed.report, "auth.no-cross-tenant-read"));
    assert.notEqual(
      idFor(forward.report, "mutation.idempotent-create"),
      idFor(forward.report, "auth.no-cross-tenant-read")
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
