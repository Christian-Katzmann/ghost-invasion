import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultEgressAllowlist, runContainerCanaryMatrix } from "./egress.js";
import { loadManualProject } from "./manual-config.js";
import { evaluateSafety } from "./safety.js";
import type { SafetyVerdict } from "./schemas/safety-verdict.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Journey } from "./schemas/journey.js";
import type { Persona } from "./schemas/persona.js";

export interface CompilePlanOptions {
  projectRoot?: string;
  baseUrl?: string;
  personas?: string[];
  journeyCount?: number;
  swarmSize?: number;
  seed?: number;
  mode?: string;
  pack?: string;
  approve?: boolean;
  runEgressCanary?: boolean;
}

export interface CompilePlanResult {
  plan: GhostInvasionPlan;
  planPath: string;
  personasMarkdown: string;
  journeysMarkdown: string;
}

interface DiscoveryArtifacts {
  reports?: Array<{ stack?: string; adapter?: string }>;
}

// Render the canonical verdict's honest containment list into the plan's string form.
// Stripe's mock identity is its containment mode (blocked-stub vs localstripe) so the
// per-mode plan prep can swap it; every other contained service is named by provider.
// This replaces the old hardcoded sink list that over-claimed mailpit/s3-stub/webhook-sink
// servers Ghost never starts (S-010, E5).
function renderPlanMocks(mocksApplied: SafetyVerdict["mocksApplied"]): string[] {
  return mocksApplied.map((mock) => (mock.service === "stripe" ? mock.via : mock.service));
}

export async function compileInvasionPlan(options: CompilePlanOptions = {}): Promise<CompilePlanResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const manualProject = await loadManualProject(projectRoot);
  const baseUrl = options.baseUrl ?? manualProject.config?.baseUrl;
  if (!baseUrl) {
    throw new Error("plan requires --base-url or a prior init --manual config with baseUrl.");
  }

  const seed = options.seed ?? 1337;
  const personas = selectPersonas(createProjectlyPersonas(), options.personas);
  const journeys = createProjectlyJourneys().slice(0, positiveInt(options.journeyCount) ?? undefined);
  const sessions = positiveInt(options.swarmSize) ?? journeys.length;
  const stack = await detectStack(projectRoot);
  const reset = manualProject.reset;
  const mode = options.mode ?? manualProject.config?.defaultMode ?? "quick";
  const egressProof = options.runEgressCanary === false ? null : await runContainerCanaryMatrix();

  // Stamp the canonical safety verdict instead of hand-building a weaker block.
  // evaluateSafety() owns the real risk model (host + env-secret scan + reset/isolation
  // trust matrix + approval policy); the plan must carry that verdict so the run gate
  // and every reader see the same truth. Reuse the egress proof already computed above
  // so the container canary runs at most once per compile.
  const verdict = await evaluateSafety({
    baseUrl,
    cwd: projectRoot,
    mode,
    mutating: true,
    resetStrategy: reset?.strategy ?? "none",
    dataIsolation: reset?.isolation ?? "unknown",
    ...(egressProof ? { egressProof } : { runEgressCanary: false })
  });

  const plan: GhostInvasionPlan = {
    $schema: "ghost-invasion/plan@1",
    createdAt: new Date().toISOString(),
    target: { baseUrl, stack, auth: manualProject.config?.auth ?? "generic" },
    mode,
    pack: options.pack ?? manualProject.config?.defaultPack ?? "launch-readiness",
    seed,
    safety: {
      targetRisk: verdict.targetRisk,
      hardStop: verdict.hardStop,
      egress: {
        mode: "container-firewall",
        proven: Boolean(egressProof?.proven),
        allowlist: egressProof?.allowlist ?? [...defaultEgressAllowlist]
      },
      liveSecrets: verdict.liveSecrets,
      mocksApplied: renderPlanMocks(verdict.mocksApplied),
      dataReset: verdict.dataReset,
      approvalRequired: verdict.approvalRequired
    },
    swarm: {
      browserConcurrency: Math.min(2, Math.max(1, sessions)),
      browserWaves: Math.ceil(sessions / Math.min(2, Math.max(1, sessions))),
      totalBrowserSessions: sessions,
      apiTier: { enabled: false, engine: "fetch", rps: 0, targets: [] },
      rateLimits: { rampMsPerContext: 750, circuitBreaker: "3%5xx|429" }
    },
    personas,
    journeys,
    surfaceHash: await surfaceHashFor(projectRoot, stack),
    approvedPlanHash: null
  };

  if (options.approve) {
    plan.approvedPlanHash = planHash(plan);
  }

  const planPath = join(projectRoot, ".ghost", "plan", "ghost-invasion-plan.json");
  const personasMarkdown = join(projectRoot, ".ghost", "plan", "personas.md");
  const journeysMarkdown = join(projectRoot, ".ghost", "plan", "journeys.md");
  await mkdir(dirname(planPath), { recursive: true });
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(personasMarkdown, renderPersonasMarkdown(plan), "utf8");
  await writeFile(journeysMarkdown, renderJourneysMarkdown(plan), "utf8");
  if (egressProof) {
    await writeFile(join(projectRoot, ".ghost", "plan", "egress-canary.json"), `${JSON.stringify(egressProof, null, 2)}\n`, "utf8");
  }

  return { plan, planPath, personasMarkdown, journeysMarkdown };
}

function createProjectlyPersonas(): Persona[] {
  const base = {
    $schema: "ghost-invasion/persona@1" as const,
    role: { name: "member", authStrategy: "none", stateRef: null },
    device: { preset: "Desktop Chrome", viewport: { width: 1280, height: 800 }, touch: false, scaleFactor: 1 },
    network: { profile: "fast", downKbps: 10_000, upKbps: 5_000, latencyMs: 20 },
    patience: { actionTimeoutMs: 5_000, maxWaitBeforeRageMs: 5_000, giveUpAfterSteps: 4 },
    timing: { thinkTimeMs: [0, 0] as [number, number], typeDelayMs: [0, 0] as [number, number] }
  };

  return [
    {
      ...base,
      id: "chaotic-user",
      archetype: "chaotic_user",
      mistakePattern: { missThreshold: 0, doubleSubmit: false, refreshMidFlow: false, backDuringSave: false, typoRate: 0 },
      dataState: { inputProfile: "double-submit", recordCountBefore: 2, fixtureRef: "projectly-seed" }
    },
    {
      ...base,
      id: "permission-boundary-user",
      archetype: "permission_boundary_user",
      mistakePattern: { missThreshold: 0, doubleSubmit: false, refreshMidFlow: false, backDuringSave: false, typoRate: 0 },
      dataState: { inputProfile: "tenant-fixture", recordCountBefore: 2, fixtureRef: "projectly-tenants" }
    },
    {
      ...base,
      id: "mis-authored-user",
      archetype: "ordinary_user",
      mistakePattern: { missThreshold: 0, doubleSubmit: false, refreshMidFlow: false, backDuringSave: false, typoRate: 0 },
      dataState: { inputProfile: "bad-expectation", recordCountBefore: 2, fixtureRef: "projectly-mis-authored" }
    }
  ];
}

function createProjectlyJourneys(): Journey[] {
  return [
    duplicateCreateJourney({
      id: "double-click-save",
      name: "Double-click Create creates duplicates",
      personaId: "chaotic-user",
      projectName: "Launch plan",
      expectInserted: 1,
      pristineRequired: true
    }),
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
        surfaceHash: "sha256:projectly"
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
    },
    duplicateCreateJourney({
      id: "mis-authored-duplicate-expectation",
      name: "Mis-authored duplicate expectation is quarantined",
      personaId: "mis-authored-user",
      projectName: "Impossible plan",
      expectInserted: 3,
      pristineRequired: true
    })
  ];
}

function duplicateCreateJourney(input: {
  id: string;
  name: string;
  personaId: string;
  projectName: string;
  expectInserted: number;
  pristineRequired: boolean;
}): Journey {
  return {
    $schema: "ghost-invasion/journey@1",
    id: input.id,
    name: input.name,
    goal: "Create must be idempotent when a real user clicks twice.",
    appliesToPersonas: [input.personaId],
    invariantsTested: ["mutation.idempotent-create"],
    pristineRequired: input.pristineRequired,
    anchors: { routes: ["/projects/new"], mutations: ["POST /api/projects"], surfaceHash: "sha256:projectly" },
    idealPath: ["goto:/projects/new", `fill:name=${input.projectName}`, "clickRole:button:Create"],
    steps: [
      { type: "goto", url: "/projects/new" },
      { type: "fill", selector: "role=textbox[name=/project name/i]", value: input.projectName },
      { type: "dbSnapshot", id: "before", table: "projects", url: "/api/projects" },
      { type: "apiCall", method: "POST", url: "/api/projects", expectStatus: 201, body: { name: input.projectName, notes: "first submit" } },
      {
        type: "apiCall",
        method: "POST",
        url: "/api/projects",
        expectStatus: 201,
        body: { name: input.projectName, notes: "duplicate submit" },
        cause: "ghost-injected",
        skipInPristine: true
      },
      { type: "wait", ms: 100 },
      { type: "dbSnapshot", id: "after", table: "projects", url: "/api/projects" }
    ],
    success: [
      {
        type: "expectDbDiff",
        table: "projects",
        before: "before",
        after: "after",
        where: { name: input.projectName },
        expectInserted: input.expectInserted,
        label: `Expected ${input.expectInserted} project row(s) after double-click`
      }
    ],
    abandon: []
  };
}

function selectPersonas(personas: Persona[], selected?: string[]): Persona[] {
  if (!selected || selected.length === 0) return personas;
  const wanted = new Set(selected);
  const filtered = personas.filter((persona) => wanted.has(persona.id) || wanted.has(persona.archetype));
  if (filtered.length === 0) {
    throw new Error(`No built-in Projectly persona matched: ${selected.join(", ")}`);
  }
  return filtered;
}

async function detectStack(projectRoot: string): Promise<string> {
  const discovered = await readDiscovered(projectRoot);
  const stack = discovered?.reports?.find((report) => report.stack)?.stack ?? discovered?.reports?.find((report) => report.adapter)?.adapter;
  if (stack) return stack;
  const packageText = await readFile(join(projectRoot, "package.json"), "utf8").catch(() => "");
  if (packageText.includes("@sveltejs/kit")) return "sveltekit";
  if (packageText.includes("next")) return "next-app";
  return "manual";
}

async function readDiscovered(projectRoot: string): Promise<DiscoveryArtifacts | null> {
  const path = join(projectRoot, ".ghost", "plan", "discovered-surfaces.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as DiscoveryArtifacts;
  } catch {
    return null;
  }
}

async function surfaceHashFor(projectRoot: string, stack: string): Promise<string> {
  const discovered = await readFile(join(projectRoot, ".ghost", "plan", "discovered-surfaces.json"), "utf8").catch(() => "");
  return `sha256:${createHash("sha256").update(`${stack}:${discovered}`).digest("hex").slice(0, 16)}`;
}

function positiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function planHash(plan: GhostInvasionPlan): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ ...plan, approvedPlanHash: null })).digest("hex")}`;
}

function renderPersonasMarkdown(plan: GhostInvasionPlan): string {
  return `${[
    "# Personas",
    "",
    `Target: ${plan.target.baseUrl}`,
    "",
    ...plan.personas.map((persona) => `- ${persona.id}: ${persona.archetype}, ${persona.device.preset}, fixture ${persona.dataState.fixtureRef}`),
    ""
  ].join("\n")}\n`;
}

function renderJourneysMarkdown(plan: GhostInvasionPlan): string {
  return `${[
    "# Journeys",
    "",
    `Mode: ${plan.mode} --pack ${plan.pack}`,
    `Plan approval hash: ${plan.approvedPlanHash ?? "not approved"}`,
    "",
    ...plan.journeys.map(
      (journey) =>
        `- ${journey.id}: ${journey.goal} (${journey.invariantsTested.join(", ")}, pristine ${journey.pristineRequired ? "required" : "not required"})`
    ),
    ""
  ].join("\n")}\n`;
}
