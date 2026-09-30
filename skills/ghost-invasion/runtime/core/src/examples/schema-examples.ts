import { finalizeRunCost, estimateRunCost } from "../cost-model.js";
import type { Finding } from "../schemas/finding.js";
import type { GhostInvasionPlan } from "../schemas/ghost-plan.js";
import type { Invariant } from "../schemas/invariant.js";
import type { Journey } from "../schemas/journey.js";
import type { Persona } from "../schemas/persona.js";
import type { RepoScan } from "../schemas/repo-scan.js";
import type { ReportJson } from "../schemas/report.js";
import type { SafetyVerdict } from "../schemas/safety-verdict.js";
import type { Surface } from "../schemas/surface.js";

export const invariantExample: Invariant = {
  $schema: "ghost-invasion/invariant@1",
  id: "mutation.idempotent-create",
  class: "hard",
  severity: "high",
  statement: "Repeating the same create must not create duplicate records.",
  evidenceRequired: ["db_diff", "replay"],
  autoAttachWhen: "create form/mutation detected"
};

export const personaExample: Persona = {
  $schema: "ghost-invasion/persona@1",
  id: "chaotic-user",
  archetype: "impatient_user",
  role: { name: "member", authStrategy: "seeded-storage-state", stateRef: "member-A.storageState.json" },
  device: { preset: "Desktop Chrome", viewport: { width: 1440, height: 900 }, touch: false, scaleFactor: 1 },
  network: { profile: "slow-3g", downKbps: 400, upKbps: 400, latencyMs: 400 },
  patience: { actionTimeoutMs: 4000, maxWaitBeforeRageMs: 4000, giveUpAfterSteps: 3 },
  mistakePattern: { missThreshold: 0.18, doubleSubmit: 0.25, refreshMidFlow: 0.15, backDuringSave: 0.1 },
  timing: { thinkTimeMs: [600, 2500], typeDelayMs: [40, 160] },
  dataState: { inputProfile: "realistic", recordCountBefore: 0, fixtureRef: "fixtures/new-account.json" }
};

export const surfaceExample: Surface = {
  $schema: "ghost-invasion/surface@1",
  id: "core.projects.create",
  name: "Create project",
  type: "core",
  stack: "sveltekit",
  routes: [{ path: "/projects/new", params: [], dynamic: false }],
  methods: ["POST"],
  kind: "form-post",
  mutationTier: "form-post",
  requiresAuth: true,
  requiresRole: ["member"],
  isDestructive: false,
  integrations: [],
  inputs: [{ name: "name", type: "text", required: true, source: "form" }],
  risk: "high",
  confidence: { exists: 1, requiresAuth: 0.7, isDestructive: 0.9 },
  evidence: [{ signal: "filesystem", ref: "demo/projectly/src/routes/projects/new/+page.server.ts", reliable: true }]
};

export const journeyExample: Journey = {
  $schema: "ghost-invasion/journey@1",
  id: "double-click-save",
  name: "Double-click Create creates duplicates",
  goal: "Impatient user double-clicks Create; app must not create two projects.",
  appliesToPersonas: [personaExample.id],
  invariantsTested: [invariantExample.id],
  pristineRequired: true,
  anchors: {
    routes: [surfaceExample.routes[0]!.path],
    mutations: [surfaceExample.id],
    surfaceHash: "sha256:projectly-step-1-1"
  },
  idealPath: ["goto:/projects/new", "fill:name=Launch plan", "clickRole:button:Create"],
  steps: [
    { type: "goto", url: "/projects/new" },
    { type: "fill", selector: "role=textbox[name=/name/i]", value: "Launch plan" },
    { type: "dbSnapshot", id: "before" },
    { type: "doubleSubmit", role: "button", name: "Create", gapMs: 80, cause: "ghost-injected" },
    { type: "wait", ms: 1500 },
    { type: "dbSnapshot", id: "after" }
  ],
  success: [{ type: "expectDbDiff", table: "projects", where: { name: "Launch plan" }, expectInserted: 1 }],
  abandon: [
    {
      type: "expectDbDiff",
      table: "projects",
      where: { name: "Launch plan" },
      expectInserted: 1,
      negate: true,
      as: "failure",
      label: "Duplicate project created on double-click"
    }
  ]
};

export const findingExample: Finding = {
  $schema: "ghost-invasion/finding@1",
  id: "F-001",
  title: "Double-click on Create creates duplicate projects",
  category: "confirmed-bug",
  severity: "critical",
  confidence: 0.93,
  invariant: invariantExample.id,
  affected: { surfaceId: surfaceExample.id, route: "/projects/new", api: "POST /projects/new?/create" },
  reproducedAcross: { personas: 1, inputProfiles: 1, seeds: 1 },
  occurrences: 2,
  pristinePassed: true,
  reproductionRate: "5/5 attempts",
  mockDependent: false,
  signals: ["db_diff_bad", "reproduced_5of5"],
  expected: "One project row per submit",
  actual: "Two rows, identical name, 180ms apart",
  evidence: ["evidence/chaotic.double-click-save.07/trace.zip", "evidence/chaotic.double-click-save.07/db-diff.json"],
  reproSteps: "reproduction-steps/F-001.md",
  minimalRepro: null,
  suggestedFix: "Add an idempotency key and disable submit on first click.",
  generatedTest: "generated-tests/F-001.spec.ts"
};

export const safetyVerdictExample: SafetyVerdict = {
  $schema: "ghost-invasion/safety-verdict@1",
  schemaVersion: "1.0",
  verdict: "allow",
  targetRisk: "local",
  hardStop: false,
  reasons: ["host=localhost in allowlist"],
  liveSecrets: [],
  egress: {
    mode: "attach-only",
    proven: false,
    canaryMatrix: {},
    allowlist: ["localhost", "127.0.0.1"]
  },
  mocksApplied: [],
  dataReset: { strategy: "user-command", isolation: "user-reset", destructiveAllowed: true },
  rateLimits: { browserConcurrency: 8, apiRps: 25, memoryAware: true },
  flags: { allowProductionTarget: false },
  approvalRequired: false,
  approvedPlanHash: null,
  explain: "Local target only; no mutating swarm launches until a reset is configured."
};

export const repoScanExample: RepoScan = {
  $schema: "ghost-invasion/repo-scan@1",
  schemaVersion: "1.0",
  scannedAt: "2026-05-30T14:20:00Z",
  rootPath: "/tmp/ghost-invasion-example",
  packageManager: "npm",
  stacks: ["sveltekit"],
  files: [
    { path: "src/routes/projects/new/+page.server.ts", kind: "sveltekit-action" },
    { path: "src/routes/api/projects/+server.ts", kind: "sveltekit-api" }
  ],
  envSignals: [],
  adapters: [{ id: "sveltekit", confidence: 1, evidence: ["svelte.config.js", "src/routes"] }]
};

export const ghostPlanExample: GhostInvasionPlan = {
  $schema: "ghost-invasion/plan@1",
  createdAt: "2026-05-30T14:20:00Z",
  target: { baseUrl: "http://127.0.0.1:5173", stack: "sveltekit", auth: "generic" },
  mode: "quick",
  pack: "launch-readiness",
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
    browserConcurrency: 8,
    browserWaves: 12,
    totalBrowserSessions: 96,
    apiTier: { enabled: true, engine: "fetch", rps: 25, targets: ["form-post:false", "rest"] },
    rateLimits: { rampMsPerContext: 750, circuitBreaker: "3%5xx|429" }
  },
  personas: [personaExample],
  journeys: [journeyExample],
  surfaceHash: "sha256:projectly-step-1-1",
  approvedPlanHash: null
};

export const reportExample: ReportJson = {
  $schema: "ghost-invasion/report@1",
  schemaVersion: "1.0",
  runId: "2026-05-30T14-22-09Z",
  target: { url: "http://127.0.0.1:5173", stack: "sveltekit", allowProductionTarget: false },
  invasion: { personas: 1, journeys: 1, pack: "launch-readiness", browserSessions: 5, apiRequests: 0, apiEndpointsHit: 0, mode: "--quick" },
  scale: { headline: "5 browser users in 1 wave + 0 API hits across 0 endpoints" },
  runStatus: { state: "completed", egressProven: true, quarantined: false, degraded: false, clean: true },
  totals: { findings: 1, critical: 1, confirmedBugs: 1, needsHumanReview: 0, falsePositivesSuppressed: 0 },
  cost: finalizeRunCost({
    estimate: estimateRunCost({ shape: { mode: "quick", browserSessions: 5, apiRequests: 0, reproductionAttempts: 5 } }),
    actual: { mode: "quick", browserSessions: 5, apiRequests: 0, reproductionAttempts: 5 }
  }),
  findings: [findingExample],
  safety: {
    mockedServices: [],
    dataResetStrategy: "user-command",
    egress: { mode: "container-firewall", proven: true },
    dangerousEnvKeysDetected: []
  }
};

export const schemaExamples = {
  repoScan: repoScanExample,
  surface: surfaceExample,
  persona: personaExample,
  journey: journeyExample,
  invariant: invariantExample,
  finding: findingExample,
  report: reportExample,
  safetyVerdict: safetyVerdictExample,
  ghostPlan: ghostPlanExample
} as const;
