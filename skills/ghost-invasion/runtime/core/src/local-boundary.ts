import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { planHash } from "./planner.js";
import { validateLoadedPlan, RunGateError } from "./run-gate.js";
import { evaluateSafety } from "./safety.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";

export interface LocalAuthorization {
  version: 1;
  boundary: "browser-origin";
  origin: string;
  planHash: string;
  resetPath: string;
  maxSessions: number;
  maxWorkers: number;
}
const authorizationPath = (root: string) => join(root, ".ghost/config/local-authorization.json");
export function localOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new RunGateError("local-only requires an HTTP target at numeric 127.0.0.1 with no credentials");
  }
  return url.origin;
}
export function assertLocalUrl(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (url.origin !== origin || url.username || url.password || !["http:"].includes(url.protocol)) {
    throw new RunGateError("local-only blocked request outside the authorized origin");
  }
  return url.toString();
}
export async function authorizeLocalRun(input: { projectRoot: string; planPath?: string; resetPath: string; maxSessions?: number; maxWorkers?: number; confirmDisposable: boolean }): Promise<LocalAuthorization> {
  if (!input.confirmDisposable) throw new RunGateError("local-only authorization requires explicit confirmation of a disposable target and reset endpoint");
  const path = input.planPath ?? join(input.projectRoot, ".ghost/plan/ghost-invasion-plan.json");
  const plan = validateLoadedPlan(JSON.parse(await readFile(path, "utf8")));
  const origin = localOrigin(plan.target.baseUrl);
  assertLocalUrl(input.resetPath, origin);
  if (!input.resetPath.startsWith("/") || input.resetPath.startsWith("//")) throw new RunGateError("reset path must be relative to the authorized origin");
  const maxSessions = input.maxSessions ?? 4;
  const maxWorkers = input.maxWorkers ?? 1;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 20 || !Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 2) throw new RunGateError("local-only caps must be 1..20 sessions and 1..2 workers");
  const authorization: LocalAuthorization = { version: 1, boundary: "browser-origin", origin, planHash: planHash(plan), resetPath: input.resetPath, maxSessions, maxWorkers };
  plan.approvedPlanHash = authorization.planHash;
  await writeFile(path, JSON.stringify(plan, null, 2) + "\n");
  await mkdir(join(input.projectRoot, ".ghost/config"), { recursive: true });
  await writeFile(authorizationPath(input.projectRoot), JSON.stringify(authorization, null, 2) + "\n", { mode: 0o600 });
  return authorization;
}
export async function assertLocalRunAllowed(input: { projectRoot: string; loadedPlan: GhostInvasionPlan; effectivePlan: GhostInvasionPlan; baseUrl: string; budgetUsd?: number; sessions: number; workers: number; reproductionBudget: number; runReset?: boolean; env?: NodeJS.ProcessEnv }) {
  let authorization: LocalAuthorization;
  try { authorization = JSON.parse(await readFile(authorizationPath(input.projectRoot), "utf8")); }
  catch { throw new RunGateError("local-only run requires authorize-local first"); }
  const plan = validateLoadedPlan(input.loadedPlan);
  const expected = planHash(plan);
  if (authorization.version !== 1 || authorization.boundary !== "browser-origin" || authorization.planHash !== expected || plan.approvedPlanHash !== expected) throw new RunGateError("local-only authorization does not match the approved plan");
  if (localOrigin(input.baseUrl) !== authorization.origin || input.baseUrl !== plan.target.baseUrl) throw new RunGateError("local-only target differs from the approved target");
  assertLocalUrl(authorization.resetPath, authorization.origin);
  if (input.effectivePlan.mode !== "quick" || plan.mode !== "quick" || input.effectivePlan.pack !== plan.pack || input.budgetUsd !== 0 || input.runReset === false || input.reproductionBudget !== 0) throw new RunGateError("local-only requires quick mode, approved pack, budget 0, resets on, and reproduction budget 0");
  if (!Number.isInteger(authorization.maxSessions) || authorization.maxSessions < 1 || authorization.maxSessions > 20 || !Number.isInteger(authorization.maxWorkers) || authorization.maxWorkers < 1 || authorization.maxWorkers > 2 || !Number.isInteger(input.sessions) || input.sessions < 1 || !Number.isInteger(input.workers) || input.workers < 1 || input.sessions > authorization.maxSessions || input.workers > authorization.maxWorkers) throw new RunGateError("local-only run exceeds its authorized session or worker limit");
  if (input.effectivePlan.swarm.apiTier.enabled || input.effectivePlan.personas.some(p => p.role.stateRef || p.role.authStrategy !== "none")) throw new RunGateError("local-only disables the API volume tier and stored authentication");
  for (const journey of input.effectivePlan.journeys) for (const step of [...journey.steps, ...journey.success, ...journey.abandon]) {
    if (step.type === "upload") throw new RunGateError("local-only does not allow file uploads");
    if (typeof step.url === "string") assertLocalUrl(step.url, authorization.origin);
  }
  const verdict = await evaluateSafety({ cwd: input.projectRoot, baseUrl: input.baseUrl, mode: "quick", mutating: false, runEgressCanary: false, env: input.env });
  if (verdict.verdict === "block" || verdict.liveSecrets.length) throw new RunGateError("local-only requires a disposable target without detected service credentials", verdict);
  verdict.mocksApplied = [];
  verdict.reasons = ["Explicitly authorized disposable target", "Browser HTTP origin guard and blocked WebSockets/service workers; no OS sandbox", "Same-origin HTTP reset required before and after execution"];
  verdict.approvalRequired = true;
  verdict.approvedPlanHash = expected;
  verdict.explain = "Explicit local browser-origin boundary: HTTP requests restricted to the approved origin, redirects checked, WebSockets and service workers blocked. Target backend and reset endpoint are trusted and are not OS-sandboxed.";
  return { authorization, verdict, approvalRequired: true, planHash: expected };
}
export async function applyLocalBrowserBoundary(context: BrowserContext, origin: string, onBlock: (url: string) => void = () => {}) {
  await context.route("**/*", async (route) => {
    try {
      assertLocalUrl(route.request().url(), origin);
      const response = await route.fetch({ maxRedirects: 0 });
      const location = response.headers().location;
      if (response.status() >= 300 && response.status() < 400 && location) assertLocalUrl(new URL(location, route.request().url()).href, origin);
      await route.fulfill({ response });
    } catch {
      onBlock(route.request().url());
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
  await context.routeWebSocket("**/*", socket => { onBlock(socket.url()); socket.close(); });
}
export async function resetLocalTarget(authorization: LocalAuthorization): Promise<void> {
  const response = await fetch(assertLocalUrl(authorization.resetPath, authorization.origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new RunGateError(`local reset endpoint returned ${response.status}`);
  await response.arrayBuffer();
}
