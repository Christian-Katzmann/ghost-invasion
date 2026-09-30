import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EvidenceBus } from "./evidence.js";
import { isLoopbackIpv4 } from "./local-host.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Surface } from "./schemas/surface.js";

export interface ApiTierTarget {
  surfaceId: string;
  method: string;
  route: string;
  url: string;
}

export interface ApiTierResult {
  enabled: boolean;
  engine: string;
  requests: number;
  endpointsHit: number;
  targets: ApiTierTarget[];
  failures: number;
  skippedReason?: string;
}

export interface ApiTierRunOptions {
  projectRoot: string;
  baseUrl: string;
  plan: GhostInvasionPlan;
  evidence: EvidenceBus;
  surfacesPath?: string;
  requestBudget?: number;
  rateRps?: number;
}

interface DiscoveredSurfacesFile {
  surfaces?: Surface[];
  reports?: Array<{ surfaces?: Surface[] }>;
}

class ApiTokenBucket {
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

export async function readDiscoveredSurfaces(path: string): Promise<Surface[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as DiscoveredSurfacesFile | Surface[];
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.surfaces)) return parsed.surfaces;
    if (Array.isArray(parsed.reports)) return parsed.reports.flatMap((report) => report.surfaces ?? []);
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function defaultDiscoveredSurfacesPath(projectRoot: string): string {
  return join(projectRoot, ".ghost", "plan", "discovered-surfaces.json");
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Mirrors the safety-gate local-host classifier (safety.ts) so the API tier accepts exactly the
// targets the gate considers local and refuses the rest, rather than second-guessing the verdict.
function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower.endsWith(".local") ||
    lower.endsWith(".test") ||
    isLoopbackIpv4(lower) ||
    isPrivateIpv4(lower)
  );
}

function assertLocalBaseUrl(baseUrl: string): void {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`API tier refuses an unparseable baseUrl "${baseUrl}"; it only runs against a local target.`);
  }
  if (!isLocalHostname(hostname)) {
    throw new Error(
      `API tier refuses a non-local baseUrl (host=${hostname}). Real fetch/k6 volume traffic only runs against a local target — re-point target.baseUrl at the local app before enabling the API tier.`
    );
  }
}

export function selectApiTierTargets(surfaces: Surface[], targetFilters: string[], baseUrl: string): ApiTierTarget[] {
  const filters = normalizeFilters(targetFilters);
  const allowRestByTier = filters.include.size === 0 || filters.include.has("rest");
  if (!allowRestByTier || filters.exclude.has("rest")) return [];

  const targets: ApiTierTarget[] = [];
  for (const surface of surfaces) {
    if (!isRestApiSurface(surface)) continue;
    if (!surfaceMatchesFilters(surface, filters.include)) continue;
    const route = surface.routes[0]?.path ?? "/";
    // `route` is an unconstrained string from discovery. `new URL(route, base)` lets an
    // absolute (`http://…`) or protocol-relative (`//…`) route discard the local base and
    // resolve off-box, which the host-side fetch/k6 would then hit outside the egress
    // container. Re-validate the *resolved* host and drop any target that isn't local.
    let resolved: URL;
    try {
      resolved = new URL(route, `${baseUrl.replace(/\/$/, "")}/`);
    } catch {
      continue;
    }
    if (!isLocalHostname(resolved.hostname)) continue;
    for (const method of methodsForSurface(surface)) {
      targets.push({
        surfaceId: surface.id,
        method,
        route,
        url: resolved.toString()
      });
    }
  }

  return dedupeTargets(targets);
}

export async function runApiVolumeTier(options: ApiTierRunOptions): Promise<ApiTierResult> {
  const tier = options.plan.swarm.apiTier;
  const engine = tier.engine || "fetch";
  if (!tier.enabled) {
    return { enabled: false, engine, requests: 0, endpointsHit: 0, targets: [], failures: 0, skippedReason: "disabled" };
  }

  // Defense-in-depth: the run-path gate already classified this target, but the API tier
  // fires real `fetch`/`k6` volume traffic from the committed-plan/AGENTS.md baseUrl, so it
  // re-asserts the target is local before any outbound request. Refuses an off-box baseUrl
  // outright rather than blasting it.
  assertLocalBaseUrl(options.baseUrl);

  const surfaces = await readDiscoveredSurfaces(options.surfacesPath ?? defaultDiscoveredSurfacesPath(options.projectRoot));
  const targets = selectApiTierTargets(surfaces, tier.targets, options.baseUrl);
  await options.evidence.append({
    type: "api-tier-start",
    engine,
    discoveredSurfaces: surfaces.length,
    eligibleTargets: targets.length,
    filters: tier.targets
  });

  if (targets.length === 0) {
    await options.evidence.append({ type: "api-tier-complete", engine, requests: 0, endpointsHit: 0, skippedReason: "no-rest-surfaces" });
    return { enabled: true, engine, requests: 0, endpointsHit: 0, targets: [], failures: 0, skippedReason: "no-rest-surfaces" };
  }

  const requestBudget = apiRequestBudget(options.requestBudget, tier.rps, targets.length);
  if (requestBudget === 0) {
    await options.evidence.append({ type: "api-tier-complete", engine, requests: 0, endpointsHit: 0, skippedReason: "budget-zero" });
    return { enabled: true, engine, requests: 0, endpointsHit: 0, targets, failures: 0, skippedReason: "budget-zero" };
  }
  if (engine === "k6") {
    return runK6ApiTier({ ...options, targets, requestBudget });
  }
  if (engine !== "fetch") {
    throw new Error(`Unsupported API tier engine "${engine}". Supported engines are "fetch" and "k6".`);
  }
  return runFetchApiTier({ ...options, targets, requestBudget });
}

function normalizeFilters(filters: string[]): { include: Set<string>; exclude: Set<string> } {
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const raw of filters) {
    const filter = raw.trim();
    if (!filter) continue;
    if (filter.endsWith(":false")) {
      exclude.add(filter.slice(0, -":false".length));
    } else {
      include.add(filter);
    }
  }
  return { include, exclude };
}

function isRestApiSurface(surface: Surface): boolean {
  return surface.mutationTier === "rest" && (surface.kind === "api" || surface.kind === "resource-route");
}

function surfaceMatchesFilters(surface: Surface, include: Set<string>): boolean {
  if (include.size === 0 || include.has("rest")) return true;
  const routes = surface.routes.map((route) => route.path);
  return include.has(surface.id) || routes.some((route) => include.has(route));
}

function methodsForSurface(surface: Surface): string[] {
  const methods = surface.methods.length > 0 ? surface.methods : ["GET"];
  return methods
    .map((method) => method.toUpperCase())
    .filter((method) => method !== "OPTIONS")
    .sort();
}

function dedupeTargets(targets: ApiTierTarget[]): ApiTierTarget[] {
  const seen = new Set<string>();
  const deduped: ApiTierTarget[] = [];
  for (const target of targets) {
    const key = `${target.method} ${target.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }
  return deduped.sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`));
}

function apiRequestBudget(explicit: number | undefined, rps: number, targetCount: number): number {
  if (Number.isFinite(explicit) && explicit !== undefined && explicit >= 0) return Math.floor(explicit);
  if (rps > 0) return Math.max(targetCount, Math.min(500, rps * 5));
  return targetCount;
}

async function runFetchApiTier(options: ApiTierRunOptions & { targets: ApiTierTarget[]; requestBudget: number }): Promise<ApiTierResult> {
  const bucket = new ApiTokenBucket(options.rateRps ?? options.plan.swarm.apiTier.rps ?? 0);
  let failures = 0;
  const endpoints = new Set<string>();

  for (let index = 0; index < options.requestBudget; index += 1) {
    const target = options.targets[index % options.targets.length]!;
    endpoints.add(`${target.method} ${target.route}`);
    await bucket.take();
    const startedAt = Date.now();
    try {
      const response = await fetch(target.url, requestInitFor(target));
      if (!response.ok) failures += 1;
      await options.evidence.append({
        type: "api-tier-request",
        engine: "fetch",
        surfaceId: target.surfaceId,
        method: target.method,
        route: target.route,
        url: target.url,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      failures += 1;
      await options.evidence.append({
        type: "api-tier-request",
        engine: "fetch",
        surfaceId: target.surfaceId,
        method: target.method,
        route: target.route,
        url: target.url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt
      });
    }
  }

  const result = {
    enabled: true,
    engine: "fetch",
    requests: options.requestBudget,
    endpointsHit: endpoints.size,
    targets: options.targets,
    failures
  };
  await options.evidence.append({ type: "api-tier-complete", ...result });
  return result;
}

async function runK6ApiTier(options: ApiTierRunOptions & { targets: ApiTierTarget[]; requestBudget: number }): Promise<ApiTierResult> {
  if (!(await commandExists("k6"))) {
    throw new Error("k6 API tier requested, but the k6 binary is not available. Install k6 or use apiTier.engine=\"fetch\".");
  }

  const scriptPath = join(options.evidence.runRoot, "api-tier-k6.js");
  await writeFile(scriptPath, renderK6Script(options.targets, options.requestBudget), "utf8");
  const run = await spawnForOutput("k6", ["run", "--quiet", scriptPath], 120_000);
  await options.evidence.append({
    type: "api-tier-k6-run",
    script: "api-tier-k6.js",
    code: run.code,
    stdout: run.stdout.slice(-4_000),
    stderr: run.stderr.slice(-4_000)
  });
  if (run.code !== 0) {
    throw new Error(`k6 API tier failed with exit code ${run.code ?? "timeout"}: ${run.stderr.trim() || run.stdout.trim()}`);
  }

  const endpoints = new Set(options.targets.map((target) => `${target.method} ${target.route}`));
  const result = {
    enabled: true,
    engine: "k6",
    requests: options.requestBudget,
    endpointsHit: endpoints.size,
    targets: options.targets,
    failures: 0
  };
  await options.evidence.append({ type: "api-tier-complete", ...result });
  return result;
}

function requestInitFor(target: ApiTierTarget): RequestInit {
  if (target.method === "GET" || target.method === "HEAD") return { method: target.method, signal: AbortSignal.timeout(20_000) };
  return {
    method: target.method,
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000)
  };
}

function renderK6Script(targets: ApiTierTarget[], iterations: number): string {
  return `import http from "k6/http";

export const options = {
  vus: 1,
  iterations: ${iterations},
  thresholds: {
    http_req_failed: ["rate<1"]
  }
};

const targets = ${JSON.stringify(targets, null, 2)};

export default function () {
  const target = targets[__ITER % targets.length];
  const params = target.method === "GET" || target.method === "HEAD" ? {} : { headers: { "content-type": "application/json" } };
  const body = target.method === "GET" || target.method === "HEAD" ? null : "{}";
  http.request(target.method, target.url, body, params);
}
`;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await access(command);
    return true;
  } catch {
    const result = await spawnForOutput(command, ["version"], 5_000);
    return result.code === 0;
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
