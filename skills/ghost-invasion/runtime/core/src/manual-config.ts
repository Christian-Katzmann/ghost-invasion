import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ensureGhostLayout } from "./ghost-layout.js";
import { evaluateSafety } from "./safety.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { SafetyVerdict } from "./schemas/safety-verdict.js";

export interface GhostProjectConfig {
  schemaVersion: "1.0";
  adapter: "manual";
  auth: "generic" | "supabase";
  baseUrl: string;
  defaultMode: string;
  defaultPack: string;
  authRole: string;
  createdAt: string;
  updatedAt: string;
}

export interface GhostResetConfig {
  schemaVersion: "1.0";
  strategy: "none" | "user-command" | "supabase-db-reset";
  isolation: "unknown" | "user-reset" | "local-stack";
  resetCommand: string | null;
  seedCommand: string | null;
  runsBefore: string[];
  runsAfter: string[];
  destructiveAllowed: boolean;
  userOwnedBoundary: boolean;
  updatedAt: string;
}

export interface ManualProject {
  config: GhostProjectConfig | null;
  reset: GhostResetConfig | null;
}

export interface WriteManualProjectOptions {
  projectRoot?: string;
  baseUrl: string;
  resetCommand?: string | null;
  seedCommand?: string | null;
  mode?: string;
  pack?: string;
  role?: string;
}

export interface WriteResetOptions {
  projectRoot?: string;
  command: string;
  seedCommand?: string | null;
}

export interface ManualPaths {
  ghostConfig: string;
  resetConfig: string;
  plan: string;
  runtimeAuth: string;
}

const defaultMode = "quick";
const defaultPack = "launch-readiness";
const defaultRole = "member";

export function resolveManualPaths(projectRoot = process.cwd()): ManualPaths {
  const root = join(projectRoot, ".ghost");
  return {
    ghostConfig: join(root, "config", "ghost.config.json"),
    resetConfig: join(root, "config", "reset.json"),
    plan: join(root, "plan", "ghost-invasion-plan.json"),
    runtimeAuth: join(root, "runtime", "auth")
  };
}

export function normalizeBaseUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function resolveAgainstBaseUrl(baseUrl: string, input?: string): string {
  if (!input) return normalizeBaseUrl(baseUrl);
  return new URL(input, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

// Mirror planner.ts: the verdict carries mocks as {service, via}; the plan stores the
// resolved string (stripe's sink id, otherwise the service name).
function renderPlanMocks(mocksApplied: SafetyVerdict["mocksApplied"]): string[] {
  return mocksApplied.map((mock) => (mock.service === "stripe" ? mock.via : mock.service));
}

function surfaceHashFor(baseUrl: string, role: string): string {
  const digest = createHash("sha256").update(`manual:${baseUrl}:${role}`).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createResetConfig(command: string | null, seedCommand: string | null): GhostResetConfig {
  const now = new Date().toISOString();
  const hasCommand = typeof command === "string" && command.trim().length > 0;
  return {
    schemaVersion: "1.0",
    strategy: hasCommand ? "user-command" : "none",
    isolation: hasCommand ? "user-reset" : "unknown",
    resetCommand: hasCommand ? command.trim() : null,
    seedCommand: seedCommand?.trim() || null,
    runsBefore: hasCommand ? ["mutating-swarm"] : [],
    runsAfter: hasCommand ? ["mutating-swarm"] : [],
    destructiveAllowed: hasCommand,
    userOwnedBoundary: hasCommand,
    updatedAt: now
  };
}

function createSupabaseResetConfig(): GhostResetConfig {
  return {
    schemaVersion: "1.0",
    strategy: "supabase-db-reset",
    isolation: "local-stack",
    resetCommand: "supabase db reset --local",
    seedCommand: null,
    runsBefore: ["mutating-swarm"],
    runsAfter: ["mutating-swarm"],
    destructiveAllowed: true,
    userOwnedBoundary: false,
    updatedAt: new Date().toISOString()
  };
}

async function createManualPlan(
  config: GhostProjectConfig,
  reset: GhostResetConfig,
  projectRoot: string
): Promise<GhostInvasionPlan> {
  const surfaceHash = surfaceHashFor(config.baseUrl, config.authRole);
  const stateRef = `${config.authRole}.storageState.json`;

  // Stamp the canonical safety verdict instead of a parallel hand-built block, so a manual
  // plan carries the same truth (host risk, env-secret scan, reset trust, approval policy)
  // as a planner-compiled plan and `approvalRequired` is always present (S-019). No container
  // canary runs on the manual path, so egress stays the honest attach-only/unproven block.
  const verdict = await evaluateSafety({
    baseUrl: config.baseUrl,
    cwd: projectRoot,
    mode: config.defaultMode,
    mutating: true,
    resetStrategy: reset.strategy,
    dataIsolation: reset.isolation,
    runEgressCanary: false
  });

  return {
    $schema: "ghost-invasion/plan@1",
    createdAt: new Date().toISOString(),
    target: { baseUrl: config.baseUrl, stack: config.adapter, auth: config.auth },
    mode: config.defaultMode,
    pack: config.defaultPack,
    seed: 1337,
    safety: {
      targetRisk: verdict.targetRisk,
      hardStop: verdict.hardStop,
      egress: { mode: "attach-only", proven: false, allowlist: ["localhost", "127.0.0.1"] },
      liveSecrets: verdict.liveSecrets,
      mocksApplied: renderPlanMocks(verdict.mocksApplied),
      dataReset: verdict.dataReset,
      approvalRequired: verdict.approvalRequired
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
        id: "manual-authenticated-user",
        archetype: "ordinary_user",
        role: { name: config.authRole, authStrategy: "storage-state", stateRef },
        device: { preset: "Desktop Chrome", viewport: { width: 1440, height: 900 }, touch: false, scaleFactor: 1 },
        network: { profile: "fast", downKbps: 10000, upKbps: 5000, latencyMs: 40 },
        patience: { actionTimeoutMs: 5000, maxWaitBeforeRageMs: 5000, giveUpAfterSteps: 4 },
        mistakePattern: { doubleSubmit: false, refreshMidFlow: false, backDuringSave: false },
        timing: { thinkTimeMs: [400, 1200], typeDelayMs: [30, 90] },
        dataState: { inputProfile: "manual", recordCountBefore: 0, fixtureRef: "manual-config" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "manual-smoke-open-home",
        name: "Manual authenticated smoke path",
        goal: "Open the configured app with the recorded browser state and confirm the page renders.",
        appliesToPersonas: ["manual-authenticated-user"],
        invariantsTested: ["ux.no-dead-end-after-error"],
        pristineRequired: true,
        anchors: { routes: ["/"], mutations: [], surfaceHash },
        idealPath: ["goto:/", "expectVisible:body"],
        steps: [{ type: "goto", url: "/" }],
        success: [{ type: "expectVisible", selector: "body" }],
        abandon: []
      }
    ],
    surfaceHash,
    approvedPlanHash: null
  };
}

export async function loadManualProject(projectRoot = process.cwd()): Promise<ManualProject> {
  const paths = resolveManualPaths(projectRoot);
  return {
    config: await readJsonIfPresent<GhostProjectConfig>(paths.ghostConfig),
    reset: await readJsonIfPresent<GhostResetConfig>(paths.resetConfig)
  };
}

export async function writeManualProject(options: WriteManualProjectOptions): Promise<{
  config: GhostProjectConfig;
  reset: GhostResetConfig;
  plan: GhostInvasionPlan;
  paths: ManualPaths;
}> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const paths = resolveManualPaths(projectRoot);
  await ensureGhostLayout(projectRoot);

  const now = new Date().toISOString();
  const existing = await loadManualProject(projectRoot);
  const config: GhostProjectConfig = {
    schemaVersion: "1.0",
    adapter: "manual",
    auth: "generic",
    baseUrl: normalizeBaseUrl(options.baseUrl),
    defaultMode: options.mode ?? existing.config?.defaultMode ?? defaultMode,
    defaultPack: options.pack ?? existing.config?.defaultPack ?? defaultPack,
    authRole: options.role ?? existing.config?.authRole ?? defaultRole,
    createdAt: existing.config?.createdAt ?? now,
    updatedAt: now
  };

  const reset =
    options.resetCommand !== undefined || options.seedCommand !== undefined
      ? createResetConfig(options.resetCommand ?? existing.reset?.resetCommand ?? null, options.seedCommand ?? existing.reset?.seedCommand ?? null)
      : existing.reset ?? createResetConfig(null, null);
  const plan = await createManualPlan(config, reset, projectRoot);

  await writeJson(paths.ghostConfig, config);
  await writeJson(paths.resetConfig, reset);
  await writeJson(paths.plan, plan);

  return { config, reset, plan, paths };
}

export async function writeUserResetConfig(options: WriteResetOptions): Promise<{
  reset: GhostResetConfig;
  plan: GhostInvasionPlan | null;
  paths: ManualPaths;
}> {
  if (!options.command.trim()) {
    throw new Error("reset command cannot be empty");
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const paths = resolveManualPaths(projectRoot);
  await ensureGhostLayout(projectRoot);
  const existing = await loadManualProject(projectRoot);
  const reset = createResetConfig(options.command, options.seedCommand ?? existing.reset?.seedCommand ?? null);
  await writeJson(paths.resetConfig, reset);

  if (!existing.config) {
    return { reset, plan: null, paths };
  }

  const plan = await createManualPlan(existing.config, reset, projectRoot);
  await writeJson(paths.plan, plan);
  return { reset, plan, paths };
}

export async function writeSupabaseResetConfig(options: { projectRoot?: string }): Promise<{
  reset: GhostResetConfig;
  plan: GhostInvasionPlan | null;
  paths: ManualPaths;
}> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const paths = resolveManualPaths(projectRoot);
  await ensureGhostLayout(projectRoot);
  const existing = await loadManualProject(projectRoot);
  const reset = createSupabaseResetConfig();
  await writeJson(paths.resetConfig, reset);

  if (!existing.config) {
    return { reset, plan: null, paths };
  }

  const config: GhostProjectConfig = { ...existing.config, auth: "supabase", updatedAt: new Date().toISOString() };
  const plan = await createManualPlan(config, reset, projectRoot);
  await writeJson(paths.ghostConfig, config);
  await writeJson(paths.plan, plan);
  return { reset, plan, paths };
}

export function storageStatePathFor(projectRoot: string, role: string, output?: string): string {
  if (output) return isAbsolute(output) ? output : resolve(projectRoot, output);
  return join(resolveManualPaths(projectRoot).runtimeAuth, `${role}.storageState.json`);
}
