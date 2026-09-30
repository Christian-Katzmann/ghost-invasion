// ===========================================================================
// swarm.ts — the deterministic run engine ("swarm" in the plan, "invasion" in
// the report, "drones" in the runtime/evidence stream; see AGENTS.md Vocabulary).
//
// Responsibility: take an approved GhostInvasionPlan, schedule fake-user drone
// sessions across browser waves + the API volume tier, execute each journey,
// capture evidence, and hand the raw run to the classifier.
//
// Safety obligations: this is the run path, so it MUST stay behind the gate.
// `runSwarm` re-evaluates the canonical verdict (run-gate.ts, extracted from
// here) and fails closed BEFORE any payment server, API request, or browser
// launches — it never trusts plan.safety blindly. The plan is loaded through
// `validateLoadedPlan` (schema + approvedPlanHash), not a bare cast.
//
// Schemas: consumes GhostInvasionPlan (schemas/ghost-plan.ts); produces
// SwarmRunResult + the events.jsonl stream (EvidenceBus) the classifier and
// dashboard read.
//
// Major sections below carry `// === <section> ===` landmarks: Types · Runtime
// primitives · Process/plan/shard helpers · Scheduling & journeys · Step
// execution & evidence · Attempt/drone/queue · runSwarm orchestration + gate.
// ===========================================================================
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { chromium, type APIResponse, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { applyLocalBrowserBoundary, assertLocalRunAllowed, assertLocalUrl, resetLocalTarget } from "./local-boundary.js";
import { appendGhostRunMemory, readGhostAgentMemory } from "./agent-memory.js";
import { runApiVolumeTier, type ApiTierResult } from "./api-tier.js";
import { classifyRun, type PristineSentinelResult } from "./classifier.js";
import { applySelectedRiskPackToPlan } from "./contracts.js";
import { finalizeRunCost, planRunCost, type CostReport } from "./cost-model.js";
import { createRunId, EvidenceBus, failureFingerprint } from "./evidence.js";
import { startLocalStripe, type LocalStripeServer } from "./localstripe.js";
import { chooseMachineAwareConcurrency } from "./memory-sizing.js";
import { loadManualProject } from "./manual-config.js";
import { redactDroneEvidence } from "./redaction.js";
import { renderReportArtifacts } from "./reporter.js";
import { assertRunAllowed, validateLoadedPlan } from "./run-gate.js";
import { normalizeRunMode, paymentJourneys, preparePlanForRunMode, type RunMode } from "./run-modes.js";
import { processTreeRssMbByMarker, RssConcurrencyWatchdog, type RssWatchdogSnapshot } from "./rss-watchdog.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Journey } from "./schemas/journey.js";
import type { Persona } from "./schemas/persona.js";

// === Types: run options, schedule items, and the SwarmRunResult contract ===
type JourneyStep = Journey["steps"][number];

interface DroneScheduleItem {
  droneId: string;
  journey: Journey;
  persona: Persona;
  seed: number;
  index: number;
}

interface ApiExecutionStats {
  requests: number;
  endpoints: Set<string>;
}

interface DbSnapshot {
  id: string;
  table: string;
  capturedAt: string;
  rows: Array<Record<string, unknown>>;
}

interface DbDiff {
  table: string;
  before: DbSnapshot;
  after: DbSnapshot;
  inserted: Array<Record<string, unknown>>;
  deleted: Array<Record<string, unknown>>;
  where: Record<string, unknown>;
  matchingInserted: Array<Record<string, unknown>>;
  expectedInserted: number;
  actualInserted: number;
  pass: boolean;
}

interface RunRuntime {
  localStripeBaseUrl?: string;
  localOrigin?: string;
}

interface AttemptResult {
  ok: boolean;
  droneId: string;
  attempt: "normal" | "trace-retry";
  traced: boolean;
  traceFingerprint?: string;
  traceOrdinal?: number;
  error?: Error;
  failureStepType?: string;
  status5xx: number;
  status429: number;
  dbDiffs: DbDiff[];
}

export interface SwarmRunOptions {
  projectRoot?: string;
  planPath?: string;
  baseUrl?: string;
  mode?: RunMode | string;
  only?: string;
  seed?: number;
  workers?: number;
  sessions?: number;
  traceCapPerFingerprint?: number;
  rateRps?: number;
  pack?: string;
  dryRun?: boolean;
  runReset?: boolean;
  allowProductionTarget?: boolean;
  env?: NodeJS.ProcessEnv;
  shard?: string | ShardSpec;
  apiSurfacesPath?: string;
  apiRequestBudget?: number;
  reproductionBudget?: number;
  budgetUsd?: number;
  writeAgentMemory?: boolean;
  localOnly?: boolean;
  rssWatchdog?: {
    maxRssMb?: number;
    minConcurrency?: number;
    sampleIntervalMs?: number;
    readRssMb?: () => Promise<number>;
  };
}

// The egress proof recorded alongside a payment simulation is derived from the actual
// run-gate verdict (which routes the validated canary result), never a hardcoded literal.
export type EgressProofLabel = "container-firewall-proven" | "container-firewall-unproven";

function egressProofLabel(proven: boolean): EgressProofLabel {
  return proven ? "container-firewall-proven" : "container-firewall-unproven";
}

export interface PaymentSimulationSummary {
  provider: "localstripe";
  baseUrl: string;
  statePath: string;
  requests: number;
  sessions: number;
  paymentIntents: number;
  realStripeTraffic: 0;
  egressProof: EgressProofLabel;
}

export interface ShardSpec {
  index: number;
  total: number;
}

export interface ReproductionBudgetSummary {
  fingerprint: string;
  attempts: number;
  reproduced: number;
  otherFailures: number;
}

export interface SwarmRunResult {
  runId: string;
  runRoot: string;
  status: "completed" | "dry-run" | "circuit-breaker";
  target: string;
  scale: {
    browserSessions: number;
    browserConcurrency: number;
    browserWaves: number;
    apiRequests: number;
    apiEndpointsHit: number;
  };
  shard?: {
    index: number;
    total: number;
    selectedSessions: number;
    totalSessions: number;
  };
  apiTier?: ApiTierResult;
  reproductionBudget?: Record<string, ReproductionBudgetSummary>;
  cost: CostReport;
  paymentSimulation?: PaymentSimulationSummary;
  watchdog?: RssWatchdogSnapshot;
  totals: {
    succeeded: number;
    failed: number;
    tracedFailures: number;
    traceSkippedByCap: number;
    status5xx: number;
    status429: number;
    orphanedChromiumProcesses: number;
  };
  evidence: {
    events: string;
    traceReservations: Record<string, number>;
    // True when the evidence spine silently degraded mid-run; threaded into
    // deriveRunStatus so an incomplete proof log forces clean:false (F4, R1).
    degraded: boolean;
  };
  pristine: {
    total: number;
    passed: number;
    failed: number;
  };
  classification?: {
    reportJson: string;
    classifierSummary: string;
    reportMarkdown: string;
    summaryHtml: string;
  };
  memory?: {
    sourcePath: string;
    factsRead: number;
    keys: string[];
    safeBaseUrlFromMemory: string | null;
    usedSafeBaseUrlFromMemory: boolean;
    updatedPath?: string;
    claudeImportsAgents?: boolean;
  };
  failures: Array<{
    droneId: string;
    journeyId: string;
    personaId: string;
    seed: number;
    message: string;
    traced: boolean;
    fingerprint: string;
  }>;
}

// === Runtime primitives: seeded RNG, human-latency filter, rate limiter, pool ===
class SwarmAssertionError extends Error {
  readonly stepType?: string;

  constructor(message: string, stepType?: string) {
    super(message);
    this.name = "SwarmAssertionError";
    this.stepType = stepType;
  }
}

class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  chance(value: unknown): boolean {
    const probability = typeof value === "boolean" ? (value ? 1 : 0) : typeof value === "number" ? value : 0;
    return probability > 0 && this.next() < Math.min(1, Math.max(0, probability));
  }
}

class HumanFilter {
  constructor(
    private readonly persona: Persona,
    private readonly rng: SeededRng,
    private readonly evidence: EvidenceBus,
    private readonly droneId: string
  ) {}

  async maybeFatFinger(page: Page, step: JourneyStep): Promise<void> {
    if (!["clickRole", "clickText"].includes(String(step.type))) return;
    if (!this.rng.chance(this.persona.mistakePattern.missThreshold)) return;
    await page.mouse.click(8 + Math.floor(this.rng.next() * 12), 8 + Math.floor(this.rng.next() * 12));
    await this.evidence.append({
      droneId: this.droneId,
      type: "human-injection",
      cause: "ghost-injected",
      injection: "fat-finger-miss",
      originalStep: step.type
    });
  }

  shouldReplaceClickWithDoubleSubmit(step: JourneyStep): boolean {
    return step.type === "clickRole" && this.rng.chance(this.persona.mistakePattern.doubleSubmit);
  }

  async maybeAfterAction(page: Page, step: JourneyStep): Promise<void> {
    if (!["clickRole", "clickText", "doubleSubmit"].includes(String(step.type))) return;

    if (this.rng.chance(this.persona.mistakePattern.refreshMidFlow)) {
      await page.waitForTimeout(80);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await this.evidence.append({
        droneId: this.droneId,
        type: "human-injection",
        cause: "ghost-injected",
        injection: "refresh-mid-save",
        originalStep: step.type
      });
    }

    if (this.rng.chance(this.persona.mistakePattern.backDuringSave)) {
      await page.waitForTimeout(80);
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await this.evidence.append({
        droneId: this.droneId,
        type: "human-injection",
        cause: "ghost-injected",
        injection: "back-during-save",
        originalStep: step.type
      });
    }
  }

  maybeTypo(value: string): { value: string; injected: boolean } {
    if (!this.rng.chance(this.persona.mistakePattern.typoRate)) return { value, injected: false };
    if (value.length === 0) return { value, injected: false };
    const index = Math.floor(this.rng.next() * value.length);
    return { value: `${value.slice(0, index)}x${value.slice(index + 1)}`, injected: true };
  }
}

class TokenBucket {
  private nextAvailable = 0;
  private readonly intervalMs: number;

  constructor(ratePerSecond: number) {
    this.intervalMs = ratePerSecond > 0 ? Math.ceil(1000 / ratePerSecond) : 0;
  }

  async take(): Promise<void> {
    if (this.intervalMs === 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextAvailable - now);
    this.nextAvailable = Math.max(now, this.nextAvailable) + this.intervalMs;
    if (waitMs > 0) await delay(waitMs);
  }
}

class BrowserPool {
  localOrigin?: string;
  private browser: Browser | null = null;
  private readonly contexts = new Set<BrowserContext>();

  constructor(
    private readonly projectRoot: string,
    private readonly runMarker: string
  ) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [`--${this.runMarker}`]
    });
  }

  async newContext(persona: Persona, options: { droneDir: string; recordFailureArtifacts: boolean }): Promise<BrowserContext> {
    if (!this.browser) throw new Error("BrowserPool has not started");
    const contextOptions: BrowserContextOptions = {
      viewport: persona.device.viewport,
      deviceScaleFactor: persona.device.scaleFactor,
      isMobile: persona.device.preset.toLowerCase().includes("iphone") || persona.device.touch,
      hasTouch: persona.device.touch,
      ...(this.localOrigin ? { serviceWorkers: "block" as const } : {})
    };

    const storageState = this.storageStatePath(persona);
    if (storageState && (await fileExists(storageState))) contextOptions.storageState = storageState;

    if (options.recordFailureArtifacts) {
      contextOptions.recordHar = { path: join(options.droneDir, "network.har"), content: "embed" };
      contextOptions.recordVideo = { dir: options.droneDir, size: persona.device.viewport };
    }

    const context = await this.browser.newContext(contextOptions);
    if (this.localOrigin) await applyLocalBrowserBoundary(context, this.localOrigin);
    this.contexts.add(context);
    return context;
  }

  // The on-disk storageState a persona authenticates from — used both to load auth and
  // to know which secret values to scrub from this drone's captured evidence.
  storageStatePath(persona: Persona): string | null {
    const stateRef = persona.role.stateRef;
    if (!stateRef) return null;
    return isAbsolute(stateRef) ? stateRef : join(this.projectRoot, ".ghost", "runtime", "auth", stateRef);
  }

  async closeContext(context: BrowserContext): Promise<void> {
    this.contexts.delete(context);
    await context.close().catch(() => undefined);
  }

  async shutdown(): Promise<{ orphaned: number }> {
    for (const context of [...this.contexts]) {
      await this.closeContext(context);
    }
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    await delay(250);

    let pids = await findProcessIdsContaining(this.runMarker);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    if (pids.length > 0) await delay(500);
    pids = await findProcessIdsContaining(this.runMarker);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    if (pids.length > 0) await delay(250);
    return { orphaned: (await findProcessIdsContaining(this.runMarker)).length };
  }
}

// === Process / plan / shard helpers: spawn, reset, loadPlan, shard math ===
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function spawnForOutput(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr, code: null });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: 127 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

async function findProcessIdsContaining(marker: string): Promise<number[]> {
  const result = await spawnForOutput("ps", ["-axo", "pid=,command="], 5_000);
  if (result.code !== 0) return [];
  const pids: number[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.includes(marker)) continue;
    const match = /^\s*(\d+)\s+/.exec(line);
    if (match) pids.push(Number(match[1]));
  }
  return pids.filter((pid) => pid !== process.pid);
}

async function runResetCommand(projectRoot: string, command: string, evidence: EvidenceBus, phase: "before" | "after"): Promise<void> {
  await evidence.append({ type: "reset-start", phase, command });
  const child = spawn(command, {
    cwd: projectRoot,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`reset command timed out during ${phase}`));
    }, 60_000);
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });

  await evidence.append({
    type: "reset-complete",
    phase,
    code,
    stdout: stdout.slice(-2_000),
    stderr: stderr.slice(-2_000)
  });
  if (code !== 0) throw new Error(`reset command failed during ${phase} with exit code ${code}`);
}

async function loadPlan(projectRoot: string, explicitPath?: string): Promise<{ plan: GhostInvasionPlan; path: string }> {
  const path = explicitPath
    ? isAbsolute(explicitPath)
      ? explicitPath
      : resolve(projectRoot, explicitPath)
    : join(projectRoot, ".ghost", "plan", "ghost-invasion-plan.json");
  const plan = validateLoadedPlan(JSON.parse(await readFile(path, "utf8")));
  return { plan, path };
}

async function readMemorySpikeMaxContexts(projectRoot: string): Promise<number> {
  const reportPath = join(projectRoot, "research", "memory-spike.md");
  try {
    const text = await readFile(reportPath, "utf8");
    const match = /Chosen max browser contexts:\s*(\d+)/i.exec(text);
    return match ? Number(match[1]) : 8;
  } catch {
    return 8;
  }
}

function parsePositiveInteger(input: unknown, fallback: number): number {
  const parsed = typeof input === "number" ? input : Number.parseInt(String(input ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseShardSpec(input: string | ShardSpec | undefined): ShardSpec | null {
  if (!input) return null;
  if (typeof input === "object") {
    return validateShardSpec(input.index, input.total);
  }
  const match = /^(\d+)\/(\d+)$/.exec(input.trim());
  if (!match) throw new Error(`Invalid --shard "${input}". Use k/n, for example 2/4.`);
  return validateShardSpec(Number(match[1]), Number(match[2]));
}

function validateShardSpec(index: number, total: number): ShardSpec {
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`Invalid shard ${index}/${total}. Shard index must be between 1 and total.`);
  }
  return { index, total };
}

function applyShard(schedule: DroneScheduleItem[], shard: ShardSpec | null): DroneScheduleItem[] {
  if (!shard) return schedule;
  return schedule.filter((_, index) => index % shard.total === shard.index - 1);
}

// === Scheduling & journeys: build the drone schedule, pristine sentinels ===
function createApiStats(): ApiExecutionStats {
  return { requests: 0, endpoints: new Set<string>() };
}

function recordApiHit(stats: ApiExecutionStats, method: string, path: string): void {
  stats.requests += 1;
  stats.endpoints.add(`${method.toUpperCase()} ${path}`);
}

function planSessions(plan: GhostInvasionPlan, override?: number): number {
  if (override && override > 0) return override;
  return Math.max(1, plan.swarm.totalBrowserSessions || plan.journeys.length * plan.personas.length);
}

function estimatePlannedApiRequests(plan: GhostInvasionPlan, explicit?: number): number {
  if (!plan.swarm.apiTier.enabled) return 0;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const targetCount = Math.max(0, plan.swarm.apiTier.targets.length);
  const rps = plan.swarm.apiTier.rps;
  if (rps > 0) return Math.max(targetCount, Math.min(500, rps * 5));
  return targetCount;
}

function personasForJourney(plan: GhostInvasionPlan, journey: Journey): Persona[] {
  const selected = plan.personas.filter((persona) => journey.appliesToPersonas.includes(persona.id));
  return selected.length > 0 ? selected : plan.personas;
}

function buildSchedule(plan: GhostInvasionPlan, options: { only?: string; seed: number; sessions: number }): DroneScheduleItem[] {
  const journeys = plan.journeys.filter((journey) => !options.only || journey.id === options.only || journey.name === options.only);
  if (journeys.length === 0) {
    throw new Error(`No journey matched --only ${options.only}`);
  }

  const schedule: DroneScheduleItem[] = [];
  for (let index = 0; index < options.sessions; index += 1) {
    const journey = journeys[index % journeys.length]!;
    const personas = personasForJourney(plan, journey);
    const persona = personas[Math.floor(index / journeys.length) % personas.length]!;
    const seed = options.seed + index;
    const droneId = `${persona.id}.${journey.id}.${String(seed).padStart(5, "0")}`;
    schedule.push({ droneId, journey, persona, seed, index });
  }
  return schedule;
}

function zeroMistakePersona(source: Persona): Persona {
  return {
    ...source,
    id: "pristine",
    archetype: "pristine_sentinel",
    device: { preset: "Desktop Chrome", viewport: { width: 1280, height: 800 }, touch: false, scaleFactor: 1 },
    network: { profile: "fast", downKbps: 10_000, upKbps: 5_000, latencyMs: 20 },
    mistakePattern: {
      missThreshold: 0,
      doubleSubmit: false,
      refreshMidFlow: false,
      backDuringSave: false,
      typoRate: 0,
      earlyTabClose: false,
      multiTabConflict: false
    },
    timing: { thinkTimeMs: [0, 0], typeDelayMs: [0, 0] }
  };
}

function pristineStep(step: JourneyStep): JourneyStep {
  if (step.type !== "doubleSubmit") return step;
  return {
    ...step,
    type: "clickRole",
    role: step.role ?? "button",
    name: step.name ?? "Submit"
  };
}

function pristineJourney(journey: Journey): Journey {
  return {
    ...journey,
    id: `${journey.id}__pristine`,
    name: `${journey.name} (pristine sentinel)`,
    steps: journey.steps.filter((step) => step.skipInPristine !== true).map(pristineStep)
  };
}

async function runPristineSentinels(input: {
  pool: BrowserPool;
  evidence: EvidenceBus;
  journeys: Journey[];
  plan: GhostInvasionPlan;
  baseUrl: string;
  seed: number;
  apiStats: ApiExecutionStats;
  runtime: RunRuntime;
}): Promise<PristineSentinelResult[]> {
  const results: PristineSentinelResult[] = [];
  const uniqueJourneys = new Map(input.journeys.map((journey) => [journey.id, journey]));
  for (const journey of uniqueJourneys.values()) {
    if (!journey.pristineRequired) continue;
    const sourcePersona = personasForJourney(input.plan, journey)[0] ?? input.plan.personas[0];
    if (!sourcePersona) continue;
    const sentinelJourney = pristineJourney(journey);
    const schedule: DroneScheduleItem = {
      droneId: `pristine.${journey.id}.${String(input.seed).padStart(5, "0")}`,
      journey: sentinelJourney,
      persona: zeroMistakePersona(sourcePersona),
      seed: input.seed,
      index: 0
    };
    const result = await runAttempt({
      pool: input.pool,
      evidence: input.evidence,
      schedule,
      baseUrl: input.baseUrl,
      attempt: "normal",
      trace: false,
      tokenBucket: new TokenBucket(0),
      apiStats: input.apiStats,
      runtime: input.runtime
    });
    const sentinel = {
      journeyId: journey.id,
      ok: result.ok,
      droneId: schedule.droneId,
      message: result.error?.message
    };
    results.push(sentinel);
    await input.evidence.append({
      type: "pristine-sentinel",
      journeyId: sentinel.journeyId,
      ok: sentinel.ok,
      droneId: sentinel.droneId,
      message: sentinel.message
    });
  }
  return results;
}

function parseMatcher(value: unknown): string | RegExp | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^\/(.+)\/([a-z]*)$/.exec(value);
  if (!match) return value;
  return new RegExp(match[1]!, match[2]);
}

function getByRole(page: Page, role: unknown, name: unknown): Locator {
  return page.getByRole(String(role) as Parameters<Page["getByRole"]>[0], { name: parseMatcher(name) });
}

function locatorFor(page: Page, selector: unknown): Locator {
  const text = String(selector ?? "");
  const roleMatch = /^role=([A-Za-z0-9_-]+)(?:\[name=(.+)\])?$/.exec(text);
  if (roleMatch) return getByRole(page, roleMatch[1], roleMatch[2]);
  if (text.startsWith("text=")) return page.getByText(parseMatcher(text.slice(5)) ?? text.slice(5));
  return page.locator(text);
}

function absoluteUrl(baseUrl: string, input: unknown, runtime: RunRuntime = {}): string {
  let value = String(input ?? "/");
  if (value.includes("{{localstripe}}")) {
    if (!runtime.localStripeBaseUrl) {
      throw new SwarmAssertionError("This payment journey requires --payments localstripe simulation.", "apiCall");
    }
    value = value.replaceAll("{{localstripe}}", runtime.localStripeBaseUrl.replace(/\/$/, ""));
  }
  const url = new URL(value, `${baseUrl.replace(/\/$/, "")}/`).toString();
  return runtime.localOrigin ? assertLocalUrl(url, runtime.localOrigin) : url;
}

async function jsonFromResponse(response: { json(): Promise<unknown> }): Promise<unknown> {
  return response.json();
}

function rowsFromJson(json: unknown, table: string): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json.filter(isRecord);
  if (isRecord(json)) {
    const direct = json[table];
    if (Array.isArray(direct)) return direct.filter(isRecord);
    if (Array.isArray(json.projects)) return json.projects.filter(isRecord);
    if (Array.isArray(json.rows)) return json.rows.filter(isRecord);
  }
  return [];
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function stableRowKey(row: Record<string, unknown>): string {
  return typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : JSON.stringify(row, Object.keys(row).sort());
}

function rowMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => row[key] === expected);
}

function diffSnapshots(before: DbSnapshot, after: DbSnapshot, where: Record<string, unknown>, expectedInserted: number): DbDiff {
  const beforeKeys = new Set(before.rows.map(stableRowKey));
  const afterKeys = new Set(after.rows.map(stableRowKey));
  const inserted = after.rows.filter((row) => !beforeKeys.has(stableRowKey(row)));
  const deleted = before.rows.filter((row) => !afterKeys.has(stableRowKey(row)));
  const matchingInserted = inserted.filter((row) => rowMatches(row, where));
  const actualInserted = matchingInserted.length;
  return {
    table: after.table,
    before,
    after,
    inserted,
    deleted,
    where,
    matchingInserted,
    expectedInserted,
    actualInserted,
    pass: actualInserted === expectedInserted
  };
}

async function captureSnapshot(page: Page, baseUrl: string, step: JourneyStep, id: string, runtime: RunRuntime): Promise<DbSnapshot> {
  const table = String(step.table ?? "projects");
  const url = absoluteUrl(baseUrl, step.url ?? `/api/${table}`, runtime);
  const response = await page.context().request.get(url, runtime.localOrigin ? { maxRedirects: 0 } : {});
  if (!response.ok()) {
    throw new SwarmAssertionError(`dbSnapshot ${id} failed: GET ${url} returned ${response.status()}`, "dbSnapshot");
  }
  const json = await jsonFromResponse(response);
  return {
    id,
    table,
    capturedAt: new Date().toISOString(),
    rows: rowsFromJson(json, table)
  };
}

async function captureApiProof(input: {
  response: APIResponse;
  evidence: EvidenceBus;
  droneId: string;
  method: string;
  url: string;
  step: JourneyStep;
}): Promise<void> {
  const shouldCaptureBody = Boolean(input.step.captureResponseBody ?? input.step.captureBody ?? input.step.ownerCheck);
  if (!shouldCaptureBody) return;

  const bodyText = await input.response.text().catch((error) => `<<unreadable response body: ${error instanceof Error ? error.message : error}>>`);
  const RESPONSE_BODY_EXCERPT_LIMIT = 20_000;
  await input.evidence.writeDroneJson(input.droneId, "response-body.json", {
    method: input.method,
    url: input.url,
    status: input.response.status(),
    // This excerpt is the target's own API response. It can carry the system-under-test's
    // PII or secrets (e.g. another tenant's record), which Ghost cannot enumerate or
    // redact. Treat it as target-owned: do not publish it outside a trusted boundary.
    capturedFrom: "target",
    bodyOwnership: "target-owned: may contain PII/secrets belonging to the system under test",
    bodyTruncated: bodyText.length > RESPONSE_BODY_EXCERPT_LIMIT,
    bodyExcerpt: bodyText.slice(0, RESPONSE_BODY_EXCERPT_LIMIT)
  });

  if (!isRecord(input.step.ownerCheck)) return;
  const expectedOwnerId = String(input.step.ownerCheck.expectedOwnerId ?? "");
  const configuredActualOwnerId = typeof input.step.ownerCheck.actualOwnerId === "string" ? input.step.ownerCheck.actualOwnerId : null;
  const actualOwnerId = configuredActualOwnerId && bodyText.includes(configuredActualOwnerId) ? configuredActualOwnerId : ownerIdFromBody(bodyText);
  await input.evidence.writeDroneJson(input.droneId, "db-owner-check.json", {
    expectedOwnerId,
    actualOwnerId,
    pass: Boolean(expectedOwnerId && actualOwnerId && expectedOwnerId === actualOwnerId),
    source: "response-body",
    route: new URL(input.url).pathname
  });
}

function ownerIdFromBody(bodyText: string): string | null {
  const match = /\buser-[a-z0-9_-]+\b/i.exec(bodyText);
  return match?.[0] ?? null;
}

async function executeDoubleSubmit(page: Page, step: JourneyStep): Promise<void> {
  const locator = getByRole(page, step.role ?? "button", step.name ?? "Submit");
  const gapMs = parsePositiveInteger(step.gapMs, 80);
  await locator.waitFor({ state: "visible", timeout: parsePositiveInteger(step.timeoutMs, 5_000) });
  await locator.evaluate((element, delayMs) => {
    const target = element as HTMLElement;
    target.click();
    if (delayMs <= 80) {
      target.click();
    } else {
      window.setTimeout(() => target.click(), delayMs);
    }
  }, gapMs);
  await page.waitForTimeout(gapMs + 50);
}

// === Step execution & evidence: run a journey step, capture proof, observe ===
async function executeStep(input: {
  page: Page;
  baseUrl: string;
  step: JourneyStep;
  snapshots: Map<string, DbSnapshot>;
  evidence: EvidenceBus;
  droneId: string;
  stepIndex: number;
  human: HumanFilter;
  apiStats: ApiExecutionStats;
  runtime: RunRuntime;
}): Promise<DbDiff[]> {
  const { page, baseUrl, step, snapshots, evidence, droneId, human, apiStats, runtime } = input;
  const dbDiffs: DbDiff[] = [];
  const startedAt = Date.now();
  await evidence.append({ droneId, type: "step-start", stepIndex: input.stepIndex, primitive: step.type });

  try {
    await human.maybeFatFinger(page, step);
    switch (step.type) {
      case "goto":
        await page.goto(absoluteUrl(baseUrl, step.url, runtime), { waitUntil: "domcontentloaded", timeout: parsePositiveInteger(step.timeoutMs, 20_000) });
        break;
      case "clickRole":
        if (human.shouldReplaceClickWithDoubleSubmit(step)) {
          await evidence.append({
            droneId,
            type: "human-injection",
            cause: "ghost-injected",
            injection: "double-submit",
            originalStep: step.type
          });
          await executeDoubleSubmit(page, { ...step, type: "doubleSubmit" });
        } else {
          await getByRole(page, step.role ?? "button", step.name).click({ timeout: parsePositiveInteger(step.timeoutMs, 5_000) });
        }
        await human.maybeAfterAction(page, step);
        break;
      case "clickText":
        await page.getByText(parseMatcher(step.text) ?? String(step.text ?? "")).click({ timeout: parsePositiveInteger(step.timeoutMs, 5_000) });
        await human.maybeAfterAction(page, step);
        break;
      case "fill": {
        const original = String(step.value ?? "");
        const maybe = human.maybeTypo(original);
        if (maybe.injected) {
          await evidence.append({
            droneId,
            type: "human-injection",
            cause: "ghost-injected",
            injection: "fat-finger-typo",
            originalStep: step.type
          });
        }
        await locatorFor(page, step.selector).fill(maybe.value, { timeout: parsePositiveInteger(step.timeoutMs, 5_000) });
        break;
      }
      case "selectOption":
        await locatorFor(page, step.selector).selectOption(String(step.value ?? ""));
        break;
      case "upload":
        await locatorFor(page, step.selector).setInputFiles(String(step.path ?? ""));
        break;
      case "expectVisible":
        await locatorFor(page, step.selector).waitFor({ state: "visible", timeout: parsePositiveInteger(step.timeoutMs, 5_000) });
        break;
      case "expectHidden":
        await locatorFor(page, step.selector).waitFor({ state: "hidden", timeout: parsePositiveInteger(step.timeoutMs, 5_000) });
        break;
      case "expectUrl":
        await page.waitForURL(parseMatcher(step.url) ?? String(step.url ?? "**"), { timeout: parsePositiveInteger(step.timeoutMs, 5_000) });
        break;
      case "expectText":
        await page.getByText(parseMatcher(step.text) ?? String(step.text ?? "")).waitFor({
          state: "visible",
          timeout: parsePositiveInteger(step.timeoutMs, 5_000)
        });
        break;
      case "expectDbRow": {
        const snapshot = await captureSnapshot(page, baseUrl, step, String(step.snapshotId ?? "expect"), runtime);
        const where = isRecord(step.where) ? step.where : {};
        if (!snapshot.rows.some((row) => rowMatches(row, where))) {
          throw new SwarmAssertionError(`Expected db row in ${snapshot.table} matching ${JSON.stringify(where)}`, "expectDbRow");
        }
        break;
      }
      case "dbSnapshot": {
        const id = String(step.id ?? `snapshot-${snapshots.size + 1}`);
        snapshots.set(id, await captureSnapshot(page, baseUrl, step, id, runtime));
        break;
      }
      case "expectDbDiff": {
        const beforeId = String(step.before ?? "before");
        const afterId = String(step.after ?? "after");
        const before = snapshots.get(beforeId);
        const after = snapshots.get(afterId) ?? (await captureSnapshot(page, baseUrl, { ...step, type: "dbSnapshot" }, afterId, runtime));
        if (!before) throw new SwarmAssertionError(`Missing db snapshot "${beforeId}"`, "expectDbDiff");
        const where = isRecord(step.where) ? step.where : {};
        const expectedInserted = parsePositiveInteger(step.expectInserted, 0);
        const diff = diffSnapshots(before, after, where, expectedInserted);
        dbDiffs.push(diff);
        await evidence.writeDroneJson(droneId, "db-diff.json", diff);
        if (!diff.pass) {
          throw new SwarmAssertionError(
            String(step.label ?? `Expected ${expectedInserted} inserted ${diff.table} row(s), saw ${diff.actualInserted}`),
            "expectDbDiff"
          );
        }
        break;
      }
      case "apiCall": {
        const method = String(step.method ?? "GET").toUpperCase();
        const url = absoluteUrl(baseUrl, step.url, runtime);
        recordApiHit(apiStats, method, new URL(url).pathname);
        const response = await page.context().request.fetch(url, {
          ...(runtime.localOrigin ? { maxRedirects: 0 } : {}),
          method,
          data: step.body,
          headers: isRecord(step.headers) ? (step.headers as Record<string, string>) : undefined
        });
        await captureApiProof({ response, evidence, droneId, method, url, step });
        const expectedStatus = parsePositiveInteger(step.expectStatus, response.status());
        if (response.status() !== expectedStatus) {
          throw new SwarmAssertionError(`apiCall ${method} ${url} expected ${expectedStatus}, saw ${response.status()}`, "apiCall");
        }
        break;
      }
      case "wait":
        await page.waitForTimeout(parsePositiveInteger(step.ms, 0));
        break;
      case "refresh":
        await page.reload({ waitUntil: "domcontentloaded" });
        break;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" });
        break;
      case "doubleSubmit":
        await executeDoubleSubmit(page, step);
        await human.maybeAfterAction(page, step);
        break;
      case "newTab":
        await page.context().newPage();
        break;
      case "screenshot":
        await page.screenshot({ path: join(await evidence.ensureDroneDir(droneId), String(step.path ?? `screenshot-${Date.now()}.png`)) });
        break;
      default:
        throw new SwarmAssertionError(`Unsupported primitive ${(step as { type: string }).type}`, String((step as { type: string }).type));
    }

    await evidence.append({
      droneId,
      type: "step-complete",
      stepIndex: input.stepIndex,
      primitive: step.type,
      durationMs: Date.now() - startedAt
    });
    return dbDiffs;
  } catch (error) {
    await evidence.append({
      droneId,
      type: "step-error",
      stepIndex: input.stepIndex,
      primitive: step.type,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

/**
 * Fire-and-forget evidence write from a page-event listener. Listeners run
 * outside any awaitable chain, so a rejected evidence write here would surface
 * as an unhandled rejection and can crash the runner — swallow it instead. The
 * write itself already records an `evidence-write-degraded` marker on failure.
 */
function swallow(write: Promise<unknown>): void {
  void write.catch(() => undefined);
}

async function attachObservers(input: {
  page: Page;
  evidence: EvidenceBus;
  droneId: string;
  counters: { status5xx: number; status429: number };
}): Promise<void> {
  const { page, evidence, droneId, counters } = input;
  page.on("console", (message) => {
    swallow(evidence.appendDroneJsonl(droneId, "console.jsonl", {
      type: "console",
      level: message.type(),
      text: message.text()
    }));
    swallow(evidence.append({ droneId, type: "console", level: message.type(), text: message.text() }));
  });
  page.on("requestfailed", (request) => {
    swallow(evidence.append({
      droneId,
      type: "requestfailed",
      method: request.method(),
      url: request.url(),
      failure: request.failure()?.errorText
    }));
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 500) counters.status5xx += 1;
    if (status === 429) counters.status429 += 1;
    swallow(evidence.append({
      droneId,
      type: "network-response",
      method: response.request().method(),
      url: response.url(),
      status,
      errorSignal: status >= 400
    }));
  });
}

// === Attempt / drone / queue: one session, its retries, and the wave queue ===
async function runAttempt(input: {
  pool: BrowserPool;
  evidence: EvidenceBus;
  schedule: DroneScheduleItem;
  baseUrl: string;
  attempt: "normal" | "trace-retry";
  trace: boolean;
  tokenBucket: TokenBucket;
  apiStats: ApiExecutionStats;
  runtime: RunRuntime;
}): Promise<AttemptResult> {
  const { pool, evidence, schedule, baseUrl, attempt, trace, tokenBucket, apiStats, runtime } = input;
  const droneId = attempt === "normal" ? schedule.droneId : `${schedule.droneId}.trace`;
  const droneDir = await evidence.ensureDroneDir(droneId);
  const counters = { status5xx: 0, status429: 0 };
  const snapshots = new Map<string, DbSnapshot>();
  const stepRecords: Array<{ index: number; primitive: string; phase: "journey" | "success"; ok: boolean; message?: string }> = [];
  const dbDiffs: DbDiff[] = [];
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let failureStepType: string | undefined;

  await evidence.append({
    droneId,
    type: "drone-start",
    attempt,
    trace,
    journeyId: schedule.journey.id,
    personaId: schedule.persona.id,
    seed: schedule.seed
  });

  try {
    await tokenBucket.take();
    context = await pool.newContext(schedule.persona, { droneDir, recordFailureArtifacts: trace });
    if (trace) await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    page = await context.newPage();
    await attachObservers({ page, evidence, droneId, counters });
    const human = new HumanFilter(schedule.persona, new SeededRng(schedule.seed), evidence, droneId);

    let index = 0;
    for (const step of schedule.journey.steps) {
      const produced = await executeStep({
        page,
        baseUrl,
        step,
        snapshots,
        evidence,
        droneId,
        stepIndex: index,
        human,
        apiStats,
        runtime
      });
      dbDiffs.push(...produced);
      stepRecords.push({ index, primitive: step.type, phase: "journey", ok: true });
      index += 1;
    }

    for (const step of schedule.journey.success) {
      const produced = await executeStep({
        page,
        baseUrl,
        step,
        snapshots,
        evidence,
        droneId,
        stepIndex: index,
        human,
        apiStats,
        runtime
      });
      dbDiffs.push(...produced);
      stepRecords.push({ index, primitive: step.type, phase: "success", ok: true });
      index += 1;
    }

    await evidence.writeDroneJson(droneId, "steps.json", stepRecords);
    await evidence.append({ droneId, type: "drone-complete", attempt, trace });
    return { ok: true, droneId, attempt, traced: trace, status5xx: counters.status5xx, status429: counters.status429, dbDiffs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failureStepType = error instanceof SwarmAssertionError ? error.stepType : undefined;
    stepRecords.push({
      index: stepRecords.length,
      primitive: failureStepType ?? "unknown",
      phase: "journey",
      ok: false,
      message
    });
    if (page) {
      await page.screenshot({ path: join(droneDir, trace ? "fail.png" : "fail-cheap.png"), fullPage: true }).catch(() => undefined);
    }
    await evidence.writeDroneJson(droneId, "steps.json", stepRecords).catch(() => undefined);
    await evidence.append({ droneId, type: "drone-failed", attempt, trace, message });
    return {
      ok: false,
      droneId,
      attempt,
      traced: trace,
      error: error instanceof Error ? error : new Error(String(error)),
      failureStepType,
      status5xx: counters.status5xx,
      status429: counters.status429,
      dbDiffs
    };
  } finally {
    if (context && trace) {
      await context.tracing.stop({ path: join(droneDir, "trace.zip") }).catch(() => undefined);
    }
    // Close the context first: that flushes recordHar to disk so the redaction pass
    // below sees the final artifact. Redaction runs on every attempt (a non-traced
    // attempt can still have written response-body.json).
    if (context) await pool.closeContext(context);
    const redaction = await redactDroneEvidence({
      droneDir,
      storageStatePath: pool.storageStatePath(schedule.persona)
    }).catch((error) => ({ deleted: [String(error)], har: false, trace: false, responseBody: false }));
    if (redaction.deleted.length > 0) {
      await evidence
        .append({ droneId, type: "evidence-redaction-failed", attempt, deleted: redaction.deleted })
        .catch(() => undefined);
    }
    await evidence.normalizeVideoArtifact(droneId).catch(() => undefined);
  }
}

async function runDrone(input: {
  pool: BrowserPool;
  evidence: EvidenceBus;
  schedule: DroneScheduleItem;
  baseUrl: string;
  tokenBucket: TokenBucket;
  apiStats: ApiExecutionStats;
  runtime: RunRuntime;
}): Promise<AttemptResult & { fingerprint?: string; traceSkippedByCap?: boolean }> {
  const first = await runAttempt({ ...input, attempt: "normal", trace: false });
  if (first.ok) return first;

  const fingerprint = failureFingerprint({
    journeyId: input.schedule.journey.id,
    personaId: input.schedule.persona.id,
    stepType: first.failureStepType,
    message: first.error?.message ?? "unknown failure"
  });
  const reservation = input.evidence.reserveTrace(fingerprint);
  await input.evidence.append({
    droneId: input.schedule.droneId,
    type: "trace-reservation",
    fingerprint,
    enabled: reservation.enabled,
    ordinal: reservation.ordinal,
    cap: reservation.cap
  });

  if (!reservation.enabled) {
    return { ...first, fingerprint, traceSkippedByCap: true };
  }

  const retry = await runAttempt({ ...input, attempt: "trace-retry", trace: true });
  return { ...retry, fingerprint, traceOrdinal: reservation.ordinal };
}

function circuitBreakerTripped(completed: number, status5xx: number, status429: number): boolean {
  if (status429 > 0) return true;
  return completed >= 10 && status5xx / completed > 0.03;
}

async function runQueue(input: {
  pool: BrowserPool;
  evidence: EvidenceBus;
  schedule: DroneScheduleItem[];
  baseUrl: string;
  concurrency: number;
  tokenBucket: TokenBucket;
  apiStats: ApiExecutionStats;
  watchdog?: RssConcurrencyWatchdog;
  runtime: RunRuntime;
}): Promise<{
  status: "completed" | "circuit-breaker";
  attempts: Array<AttemptResult & { schedule: DroneScheduleItem; fingerprint?: string; traceSkippedByCap?: boolean }>;
  totals: { status5xx: number; status429: number };
}> {
  const attempts: Array<AttemptResult & { schedule: DroneScheduleItem; fingerprint?: string; traceSkippedByCap?: boolean }> = [];
  let nextIndex = 0;
  let status5xx = 0;
  let status429 = 0;
  let stopped = false;

  async function worker(workerIndex: number): Promise<void> {
    while (!stopped) {
      await input.watchdog?.waitForTurn(workerIndex);
      if (stopped) return;
      const item = input.schedule[nextIndex];
      nextIndex += 1;
      if (!item) return;
      const result = await runDrone({
        pool: input.pool,
        evidence: input.evidence,
        schedule: item,
        baseUrl: input.baseUrl,
        tokenBucket: input.tokenBucket,
        apiStats: input.apiStats,
        runtime: input.runtime
      });
      attempts.push({ ...result, schedule: item });
      status5xx += result.status5xx;
      status429 += result.status429;
      if (circuitBreakerTripped(attempts.length, status5xx, status429)) {
        stopped = true;
        await input.evidence.append({
          type: "circuit-breaker",
          completed: attempts.length,
          status5xx,
          status429,
          threshold: "3%5xx|429"
        });
      }
    }
  }

  input.watchdog?.start();
  try {
    await Promise.all(Array.from({ length: input.concurrency }, (_, workerIndex) => worker(workerIndex)));
  } finally {
    input.watchdog?.stop();
  }
  return { status: stopped ? "circuit-breaker" : "completed", attempts, totals: { status5xx, status429 } };
}

async function runReproductionBudget(input: {
  budget: number;
  attempts: Array<AttemptResult & { schedule: DroneScheduleItem; fingerprint?: string }>;
  pool: BrowserPool;
  evidence: EvidenceBus;
  baseUrl: string;
  tokenBucket: TokenBucket;
  apiStats: ApiExecutionStats;
  runtime: RunRuntime;
}): Promise<Record<string, ReproductionBudgetSummary>> {
  if (input.budget <= 0) return {};
  const failedByFingerprint = new Map<string, DroneScheduleItem>();
  for (const attempt of input.attempts) {
    if (attempt.ok || !attempt.fingerprint) continue;
    if (!failedByFingerprint.has(attempt.fingerprint)) {
      failedByFingerprint.set(attempt.fingerprint, attempt.schedule);
    }
  }

  const summaries: Record<string, ReproductionBudgetSummary> = {};
  for (const [fingerprint, schedule] of failedByFingerprint) {
    const summary: ReproductionBudgetSummary = { fingerprint, attempts: 0, reproduced: 0, otherFailures: 0 };
    await input.evidence.append({ type: "reproduction-budget-start", fingerprint, attempts: input.budget, sourceDroneId: schedule.droneId });
    for (let index = 0; index < input.budget; index += 1) {
      const reproSchedule = {
        ...schedule,
        droneId: `${schedule.droneId}.repro-${index + 1}`,
        seed: schedule.seed + index + 1_000_000
      };
      const result = await runAttempt({
        pool: input.pool,
        evidence: input.evidence,
        schedule: reproSchedule,
        baseUrl: input.baseUrl,
        attempt: "normal",
        trace: false,
        tokenBucket: input.tokenBucket,
        apiStats: input.apiStats,
        runtime: input.runtime
      });
      summary.attempts += 1;
      let reproduced = false;
      let rerunFingerprint: string | null = null;
      if (!result.ok) {
        rerunFingerprint = failureFingerprint({
          journeyId: schedule.journey.id,
          personaId: schedule.persona.id,
          stepType: result.failureStepType,
          message: result.error?.message ?? "unknown failure"
        });
        reproduced = rerunFingerprint === fingerprint;
        if (reproduced) summary.reproduced += 1;
        else summary.otherFailures += 1;
      }
      await input.evidence.append({
        type: "reproduction-budget-attempt",
        fingerprint,
        rerunFingerprint,
        reproduced,
        ok: result.ok,
        droneId: reproSchedule.droneId,
        seed: reproSchedule.seed
      });
    }
    summaries[fingerprint] = summary;
    await input.evidence.append({ type: "reproduction-budget-complete", ...summary });
  }
  return summaries;
}

function cpusFallbackConcurrency(): number {
  return Math.max(1, Math.min(4, cpus().length || 1));
}

// === runSwarm: load + validate the plan, re-evaluate the safety gate, then
//     execute waves and the API tier. This is the seam the run path enters. ===
export async function runSwarm(options: SwarmRunOptions = {}): Promise<SwarmRunResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const loaded = await loadPlan(projectRoot, options.planPath);
  const selectedPack = options.pack ?? loaded.plan.pack;
  const requestedMode = normalizeRunMode(String(options.mode ?? loaded.plan.mode));
  const plan = preparePlanForRunMode(await applySelectedRiskPackToPlan(loaded.plan, { projectRoot, packId: selectedPack }), requestedMode);
  const agentMemory = await readGhostAgentMemory(projectRoot);
  const memoryKeys = Object.keys(agentMemory.facts).sort();
  const planBaseUrl = plan.target.baseUrl.trim();
  const baseUrl = options.baseUrl ?? (planBaseUrl ? plan.target.baseUrl : agentMemory.facts.safe_base_url);
  if (!baseUrl) {
    throw new Error("No target base URL found in the plan or AGENTS.md Ghost Invasion memory.");
  }
  const memorySummary = {
    sourcePath: agentMemory.sourcePath,
    factsRead: memoryKeys.length,
    keys: memoryKeys,
    safeBaseUrlFromMemory: agentMemory.facts.safe_base_url ?? null,
    usedSafeBaseUrlFromMemory: !options.baseUrl && !planBaseUrl && Boolean(agentMemory.facts.safe_base_url)
  };
  const seed = options.seed ?? plan.seed;
  const paymentMode = plan.mode === "payments";
  if (paymentMode) {
    const journeys = paymentJourneys(plan);
    if (journeys.length === 0) {
      throw new Error("ghost-invasion run --payments requires at least one checkout/payment journey in the approved plan.");
    }
    if (!plan.safety.egress.proven) {
      throw new Error("ghost-invasion run --payments requires a proven container-firewall egress trap before localstripe can run.");
    }
  }
  const requestedSessions = planSessions(plan, options.sessions);
  const requestedReproductionBudget = options.reproductionBudget ?? (plan.mode === "deep" ? 20 : 0);
  const budgetDecision = planRunCost({
    budgetUsd: options.budgetUsd,
    shape: {
      mode: plan.mode,
      browserSessions: requestedSessions,
      apiRequests: estimatePlannedApiRequests(plan, options.apiRequestBudget),
      reproductionAttempts: requestedReproductionBudget
    }
  });
  const sessions = budgetDecision.shape.browserSessions;
  const fullSchedule = buildSchedule(plan, { only: options.only, seed, sessions });
  const shard = parseShardSpec(options.shard);
  const schedule = applyShard(fullSchedule, shard);
  if (schedule.length === 0) {
    throw new Error(`Shard ${shard?.index}/${shard?.total} selected zero sessions from ${fullSchedule.length} scheduled sessions.`);
  }
  const memoryMax = await readMemorySpikeMaxContexts(projectRoot);
  // The run gate (assertRunAllowed, below) already fails closed on machineMax === 0 via the
  // same chooseMachineAwareConcurrency() check inside evaluateSafety, so a too-small machine
  // never reaches a browser spawn. No separate single-context degraded path is needed here —
  // Math.max(1, …) only ever floors the concurrency of a machine the gate has cleared.
  const machineMax = chooseMachineAwareConcurrency();
  const requestedWorkers = options.workers ?? plan.swarm.browserConcurrency ?? cpusFallbackConcurrency();
  const concurrency = Math.max(1, Math.min(8, memoryMax, machineMax, requestedWorkers, schedule.length));
  const waves = Math.ceil(schedule.length / concurrency);
  const evidence = new EvidenceBus({
    projectRoot,
    runId: shard ? `${createRunId()}.shard-${shard.index}-of-${shard.total}` : undefined,
    traceCapPerFingerprint: options.traceCapPerFingerprint
  });
  await evidence.init();
  await evidence.append({ type: "agent-memory-read", sourcePath: agentMemory.sourcePath, factsRead: memoryKeys.length, keys: memoryKeys });
  await evidence.append({
    type: "cost-budget-plan",
    budgetUsd: budgetDecision.cost.budgetUsd,
    estimatedUsd: budgetDecision.cost.estimatedUsd,
    withinBudget: budgetDecision.cost.withinBudget,
    degraded: budgetDecision.cost.degraded,
    degradations: budgetDecision.cost.degradations
  });

  const summaryBase = {
    runId: evidence.runId,
    runRoot: evidence.runRoot,
    target: baseUrl,
    scale: {
      browserSessions: schedule.length,
      browserConcurrency: concurrency,
      browserWaves: waves,
      apiRequests: 0,
      apiEndpointsHit: 0
    }
  };
  const shardSummary = shard
    ? {
        index: shard.index,
        total: shard.total,
        selectedSessions: schedule.length,
        totalSessions: fullSchedule.length
      }
    : undefined;
  const runtime: RunRuntime = {};

  if (options.dryRun) {
    const dryRunCost = finalizeRunCost({
      estimate: budgetDecision.cost,
      actual: { mode: plan.mode, browserSessions: 0, apiRequests: 0, reproductionAttempts: 0, reportRenders: 0 }
    });
    const result: SwarmRunResult = {
      ...summaryBase,
      shard: shardSummary,
      status: "dry-run",
      apiTier: { enabled: false, engine: plan.swarm.apiTier.engine, requests: 0, endpointsHit: 0, targets: [], failures: 0, skippedReason: "dry-run" },
      reproductionBudget: {},
      totals: {
        succeeded: 0,
        failed: 0,
        tracedFailures: 0,
        traceSkippedByCap: 0,
        status5xx: 0,
        status429: 0,
        orphanedChromiumProcesses: 0
      },
      evidence: { events: evidence.eventsPath, traceReservations: {}, degraded: evidence.summary().degraded },
      pristine: { total: 0, passed: 0, failed: 0 },
      cost: dryRunCost,
      memory: memorySummary,
      failures: []
    };
    await evidence.writeRunJson("swarm-summary.json", result);
    await evidence.flush();
    return result;
  }

  // Pre-run safety gate (R4/R2/R3): re-evaluate the verdict against the live target and
  // fail closed before any payment server, API-tier request, or browser pool can run.
  const manualProject = await loadManualProject(projectRoot);
  const localGate = options.localOnly ? await assertLocalRunAllowed({ projectRoot, loadedPlan: loaded.plan, effectivePlan: plan, baseUrl, budgetUsd: options.budgetUsd, sessions: requestedSessions, workers: requestedWorkers, reproductionBudget: requestedReproductionBudget, runReset: options.runReset, env: options.env }) : null;
  if (localGate) runtime.localOrigin = localGate.authorization.origin;
  const gate = localGate ?? await assertRunAllowed({
    loadedPlan: loaded.plan,
    projectRoot,
    baseUrl,
    mode: plan.mode,
    reset: manualProject.reset,
    allowProductionTarget: options.allowProductionTarget,
    env: options.env
  });
  await evidence.append({
    type: "run-gate-verdict",
    verdict: gate.verdict.verdict,
    targetRisk: gate.verdict.targetRisk,
    approvalRequired: gate.approvalRequired,
    boundary: localGate ? "browser-origin" : "legacy-container-proof",
    egressProven: gate.verdict.egress.proven
  });

  let localStripe: LocalStripeServer | null = null;
  let paymentSimulation: PaymentSimulationSummary | undefined;
  if (paymentMode) {
    localStripe = await startLocalStripe();
    runtime.localStripeBaseUrl = localStripe.baseUrl;
    await evidence.append({
      type: "payment-simulation-start",
      provider: "localstripe",
      baseUrl: localStripe.baseUrl,
      egressProof: egressProofLabel(gate.verdict.egress.proven),
      realStripeTraffic: 0
    });
  }

  const shouldRunReset = options.runReset ?? true;
  if (localGate) {
    await resetLocalTarget(localGate.authorization);
    await evidence.append({ type: "reset-complete", phase: "before", boundary: "browser-origin" });
  }
  if (!localGate && shouldRunReset && manualProject.reset?.resetCommand && manualProject.reset.runsBefore.includes("mutating-swarm")) {
    await runResetCommand(projectRoot, manualProject.reset.resetCommand, evidence, "before");
  }

  const pool = new BrowserPool(projectRoot, `ghost-invasion-${evidence.runId}`);
  pool.localOrigin = runtime.localOrigin;
  const apiStats = createApiStats();
  let queueResult: Awaited<ReturnType<typeof runQueue>> | null = null;
  let pristineResults: PristineSentinelResult[] = [];
  let apiTierResult: ApiTierResult = {
    enabled: false,
    engine: plan.swarm.apiTier.engine,
    requests: 0,
    endpointsHit: 0,
    targets: [],
    failures: 0,
    skippedReason: "not-run"
  };
  let reproductionBudget: Record<string, ReproductionBudgetSummary> = {};
  let watchdogSnapshot: RssWatchdogSnapshot | undefined;
  let orphaned = 0;
  const tokenBucket = new TokenBucket(options.rateRps ?? plan.swarm.apiTier.rps ?? 0);
  const watchdog = new RssConcurrencyWatchdog({
    initialConcurrency: concurrency,
    maxRssMb: options.rssWatchdog?.maxRssMb,
    minConcurrency: options.rssWatchdog?.minConcurrency,
    sampleIntervalMs: options.rssWatchdog?.sampleIntervalMs,
    readRssMb: options.rssWatchdog?.readRssMb ?? (() => processTreeRssMbByMarker(`ghost-invasion-${evidence.runId}`)),
    onShed: (event) => evidence.append({ type: "rss-watchdog-shed", ...event })
  });

  try {
    apiTierResult = await runApiVolumeTier({
      projectRoot,
      baseUrl,
      plan,
      evidence,
      surfacesPath: options.apiSurfacesPath,
      requestBudget: budgetDecision.apiRequestBudget,
      rateRps: options.rateRps
    });
    for (const target of apiTierResult.targets) {
      apiStats.endpoints.add(`${target.method} ${target.route}`);
    }
    apiStats.requests += apiTierResult.requests;

    await pool.start();
    pristineResults = await runPristineSentinels({
      pool,
      evidence,
      journeys: [...new Map(schedule.map((item) => [item.journey.id, item.journey])).values()],
      plan,
      baseUrl,
      seed,
      apiStats,
      runtime
    });
    queueResult = await runQueue({
      pool,
      evidence,
      schedule,
      baseUrl,
      concurrency,
      tokenBucket,
      apiStats,
      watchdog,
      runtime
    });
    const defaultReproductionBudget = plan.mode === "deep" ? 20 : 0;
    reproductionBudget = await runReproductionBudget({
      budget: budgetDecision.reproductionBudget ?? defaultReproductionBudget,
      attempts: queueResult.attempts,
      pool,
      evidence,
      baseUrl,
      tokenBucket,
      apiStats,
      runtime
    });
  } finally {
    watchdogSnapshot = watchdog.snapshot();
    orphaned = (await pool.shutdown()).orphaned;
    if (localStripe) {
      try {
        const statePath = await localStripe.writeState(evidence.runRoot);
        const state = localStripe.state();
        paymentSimulation = {
          provider: "localstripe",
          baseUrl: localStripe.baseUrl,
          statePath,
          requests: state.requests.length,
          sessions: state.sessions.length,
          paymentIntents: state.paymentIntents.length,
          realStripeTraffic: 0,
          egressProof: egressProofLabel(gate.verdict.egress.proven)
        };
        await evidence.writeRunJson("payment-simulation.json", paymentSimulation);
        await evidence.append({ type: "payment-simulation-complete", ...paymentSimulation });
      } finally {
        await localStripe.stop();
      }
    }
    if (localGate) {
      await resetLocalTarget(localGate.authorization);
      await evidence.append({ type: "reset-complete", phase: "after", boundary: "browser-origin" });
    }
    if (!localGate && shouldRunReset && manualProject.reset?.resetCommand && manualProject.reset.runsAfter.includes("mutating-swarm")) {
      await runResetCommand(projectRoot, manualProject.reset.resetCommand, evidence, "after");
    }
  }

  const attempts = queueResult?.attempts ?? [];
  const failures = attempts
    .filter((attempt) => !attempt.ok)
    .map((attempt) => ({
      droneId: attempt.schedule.droneId,
      journeyId: attempt.schedule.journey.id,
      personaId: attempt.schedule.persona.id,
      seed: attempt.schedule.seed,
      message: attempt.error?.message ?? "unknown failure",
      traced: Boolean(attempt.traced),
      fingerprint: attempt.fingerprint ?? "unfingerprinted"
    }));
  const traceReservations = evidence.summary().traceReservations;
  const actualCost = finalizeRunCost({
    estimate: budgetDecision.cost,
    actual: {
      mode: plan.mode,
      browserSessions: schedule.length,
      apiRequests: apiStats.requests,
      reproductionAttempts: Object.values(reproductionBudget).reduce((total, summary) => total + summary.attempts, 0),
      reportRenders: 1
    }
  });
  const result: SwarmRunResult = {
    ...summaryBase,
    shard: shardSummary,
    apiTier: apiTierResult,
    reproductionBudget,
    cost: actualCost,
    paymentSimulation,
    watchdog: watchdogSnapshot,
    status: queueResult?.status ?? "completed",
    scale: {
      ...summaryBase.scale,
      apiRequests: apiStats.requests,
      apiEndpointsHit: apiStats.endpoints.size
    },
    totals: {
      succeeded: attempts.filter((attempt) => attempt.ok).length,
      failed: failures.length,
      tracedFailures: attempts.filter((attempt) => !attempt.ok && attempt.traced).length,
      traceSkippedByCap: attempts.filter((attempt) => attempt.traceSkippedByCap).length,
      status5xx: queueResult?.totals.status5xx ?? 0,
      status429: queueResult?.totals.status429 ?? 0,
      orphanedChromiumProcesses: orphaned
    },
    evidence: {
      events: evidence.eventsPath,
      traceReservations,
      degraded: evidence.summary().degraded
    },
    pristine: {
      total: pristineResults.length,
      passed: pristineResults.filter((result) => result.ok).length,
      failed: pristineResults.filter((result) => !result.ok).length
    },
    memory: memorySummary,
    failures
  };

  await evidence.writeRunJson("swarm-summary.json", result);
  await evidence.append({ type: "swarm-complete", status: result.status, totals: result.totals, scale: result.scale });
  await evidence.flush();
  const classification = await classifyRun({ projectRoot, plan, swarmSummary: result, pristineResults, cost: actualCost });
  const artifacts = await renderReportArtifacts({ report: classification.report, runRoot: evidence.runRoot });
  result.classification = {
    reportJson: classification.reportPath,
    classifierSummary: classification.summaryPath,
    reportMarkdown: artifacts.reportMarkdown,
    summaryHtml: artifacts.summaryHtml
  };
  if (options.writeAgentMemory === true) {
    const memoryWrite = await appendGhostRunMemory({
      projectRoot,
      plan,
      runId: evidence.runId,
      reportPath: classification.reportPath
    });
    result.memory = {
      ...memorySummary,
      updatedPath: memoryWrite.agentsPath,
      claudeImportsAgents: memoryWrite.claudeImportsAgents
    };
    await evidence.append({
      type: "agent-memory-written",
      path: memoryWrite.agentsPath,
      facts: Object.keys(memoryWrite.facts).sort(),
      claudeImportsAgents: memoryWrite.claudeImportsAgents
    });
  }
  await evidence.writeRunJson("swarm-summary.json", result);
  await writeFile(join(evidence.runRoot, "README.md"), renderRunReadme(result), "utf8");
  return result;
}

function renderRunReadme(result: SwarmRunResult): string {
  return `# Ghost Invasion Run ${result.runId}

Target: ${result.target}
Scale: ${result.scale.browserSessions} browser sessions in ${result.scale.browserWaves} wave(s)
Cost: estimated $${result.cost.estimatedUsd.toFixed(4)}, actual $${result.cost.actualUsd.toFixed(4)}
Status: ${result.status}

Start here in later phases:
- events.jsonl: append-only event spine
- swarm-summary.json: machine summary for classifier/reporting
- report.md: START HERE, prioritized human report
- report.json: classified findings with deterministic confidence ceilings
- summary.html: shareable visual report with replay links
- evidence/: per-drone traces, screenshots, HAR, console, and DB diffs
`;
}

export async function latestRunRoot(projectRoot = process.cwd()): Promise<string | null> {
  const runsRoot = join(projectRoot, ".ghost", "runs");
  try {
    const entries = (await readdir(runsRoot)).sort();
    const latest = entries.at(-1);
    return latest ? join(runsRoot, latest) : null;
  } catch {
    return null;
  }
}
