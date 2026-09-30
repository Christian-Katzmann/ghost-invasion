// ===========================================================================
// discovery/route-probe.ts — runtime route discovery for server frameworks.
//
// Responsibility: for stacks whose routes are only knowable at runtime (Express,
// Hono), boot the user's app inside the container-firewall egress boundary and
// introspect its registered routes, rather than reading them off the filesystem
// like the AST adapters in discovery.ts. Express/Hono are StackAdapters and stay
// registered through `stackAdapters` in discovery.ts.
//
// Note on the discovery.ts import: it is a deliberate, eval-safe cycle. This
// module only calls those shared helpers at runtime (inside methods), never at
// module load, and discovery.ts constructs the adapter instances only after this
// module has fully evaluated its class declarations.
// ===========================================================================
import { spawn } from "node:child_process";
import { relative, resolve } from "node:path";
import { buildContainerFirewallRunCommand } from "../egress.js";
import type { RepoScan } from "../schemas/repo-scan.js";
import type { Surface } from "../schemas/surface.js";
import {
  baseSurface,
  dependencyNames,
  httpMethods,
  httpMethodSet,
  pathExists,
  readPackageJson,
  repoScan,
  requiresAuthFromSource,
  routeEvidence,
  slug,
  sortSurfaces,
  surfaceHash,
  titleFromRoute,
  toPosix,
  walkFiles,
  type AppHandle,
  type DiscoveryDegradation,
  type DiscoveryOptions,
  type DiscoveryReport,
  type GhostEnv,
  type MutationTier,
  type StackAdapter
} from "../discovery.js";

interface RuntimeRouteProbeRoute {
  path: string;
  methods: string[];
  requiresAuth?: boolean;
}

const runtimeRouteProbeScript = `
import { pathToFileURL } from "node:url";
const entry = process.env.GHOST_ROUTE_PROBE_ENTRY;
if (!entry) throw new Error("GHOST_ROUTE_PROBE_ENTRY is required");
const mod = await import(pathToFileURL(entry).href);
const app = mod.default ?? mod.app ?? mod.server ?? mod.router;
const routes = [];
const add = (method, path) => {
  if (!method || !path) return;
  routes.push({ method: String(method).toUpperCase(), path: String(path) });
};
const addRoute = (route) => {
  if (!route) return;
  const methods = route.methods ?? (route.method ? [route.method] : []);
  for (const method of methods) add(method, route.path);
};
if (typeof mod.__ghostRouteProbe === "function") {
  for (const route of await mod.__ghostRouteProbe()) addRoute(route);
}
if (Array.isArray(app?.__ghostRoutes)) {
  for (const route of app.__ghostRoutes) addRoute(route);
}
if (Array.isArray(app?.routes)) {
  for (const route of app.routes) addRoute(route.method, route.path);
}
const walkExpress = (stack) => {
  for (const layer of stack ?? []) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods ?? {}).filter((method) => layer.route.methods[method]);
      for (const method of methods) add(method, layer.route.path);
    }
    if (layer.handle?.stack) walkExpress(layer.handle.stack);
  }
};
walkExpress(app?._router?.stack ?? app?.router?.stack ?? app?.stack);
console.log(JSON.stringify({ routes }));
`;

function routeProbeConfig(packageJson: Record<string, unknown> | null): Record<string, unknown> {
  const value = packageJson?.ghostInvasion;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function configuredRouteProbeStack(packageJson: Record<string, unknown> | null): string | null {
  const config = routeProbeConfig(packageJson);
  if (typeof config.routeProbeStack === "string") return config.routeProbeStack;
  if (config.routeProbe && typeof config.routeProbe === "object" && typeof (config.routeProbe as Record<string, unknown>).stack === "string") {
    return String((config.routeProbe as Record<string, unknown>).stack);
  }
  return null;
}

async function routeProbeEntryFor(projectRoot: string): Promise<string | null> {
  const packageJson = await readPackageJson(projectRoot);
  const config = routeProbeConfig(packageJson);
  const configured = config.routeProbe;
  if (typeof configured === "string") {
    const candidate = resolve(projectRoot, configured);
    if (await pathExists(candidate)) return candidate;
  }
  if (configured && typeof configured === "object" && typeof (configured as Record<string, unknown>).entry === "string") {
    const candidate = resolve(projectRoot, String((configured as Record<string, unknown>).entry));
    if (await pathExists(candidate)) return candidate;
  }

  for (const rel of ["src/app.mjs", "src/app.js", "app.mjs", "app.js", "src/server.mjs", "src/server.js", "server.mjs", "server.js"]) {
    const candidate = resolve(projectRoot, rel);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function runRouteProbe(repo: RepoScan, options: DiscoveryOptions): Promise<{ routes: RuntimeRouteProbeRoute[]; degradation?: DiscoveryDegradation }> {
  const timeoutMs = options.routeProbeTimeoutMs ?? 10_000;
  const entry = await routeProbeEntryFor(repo.rootPath);
  const args = options.routeProbeCommand ? ["-lc", options.routeProbeCommand] : ["--input-type=module", "--eval", runtimeRouteProbeScript];
  const command = options.routeProbeCommand ? "sh" : process.execPath;

  if (!entry && !options.routeProbeCommand) {
    return {
      routes: [],
      degradation: {
        code: "runtime-route-probe-missing",
        message: "No route probe entry was found for runtime adapter discovery.",
        evidence: ["package.json:ghostInvasion.routeProbe", "src/app.mjs", "src/server.mjs"]
      }
    };
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repo.rootPath,
      env: { ...process.env, GHOST_ROUTE_PROBE_ENTRY: entry ?? "", GHOST_ROUTE_PROBE: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({
        routes: [],
        degradation: {
          code: "runtime-route-probe-timeout",
          message: `Runtime route probe timed out after ${timeoutMs}ms.`,
          evidence: [entry ?? options.routeProbeCommand ?? "route-probe"]
        }
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-100_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        routes: [],
        degradation: {
          code: "runtime-route-probe-failed",
          message: `Runtime route probe failed to start: ${error.message}`,
          evidence: [entry ?? options.routeProbeCommand ?? "route-probe"]
        }
      });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          routes: [],
          degradation: {
            code: "runtime-route-probe-failed",
            message: `Runtime route probe exited code=${code ?? "null"} signal=${signal ?? "none"}.`,
            evidence: [stderr.trim() || entry || options.routeProbeCommand || "route-probe"]
          }
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1)) as { routes?: unknown };
        resolve({ routes: normalizeRuntimeRoutes(parsed.routes) });
      } catch (error) {
        resolve({
          routes: [],
          degradation: {
            code: "runtime-route-probe-unparseable",
            message: `Runtime route probe did not emit parseable JSON: ${(error as Error).message}`,
            evidence: [stdout.trim().slice(-2000)]
          }
        });
      }
    });
  });
}

function normalizeRuntimeRoutes(value: unknown): RuntimeRouteProbeRoute[] {
  if (!Array.isArray(value)) return [];
  const byPath = new Map<string, Set<string>>();
  const authByPath = new Map<string, boolean>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : null;
    if (!path) continue;
    const rawMethods = Array.isArray(record.methods) ? record.methods : record.method ? [record.method] : [];
    const methods = rawMethods.map((method) => String(method).toUpperCase()).filter((method) => httpMethodSet.has(method));
    if (methods.length === 0) continue;
    const bucket = byPath.get(path) ?? new Set<string>();
    for (const method of methods) bucket.add(method);
    byPath.set(path, bucket);
    if (record.requiresAuth === true) authByPath.set(path, true);
  }
  return [...byPath.entries()].map(([path, methods]) => ({
    path,
    methods: httpMethods.filter((method) => methods.has(method)),
    requiresAuth: authByPath.get(path)
  }));
}

function routeFromRuntimePath(path: string): { path: string; params: string[]; dynamic: boolean } {
  const params: string[] = [];
  const normalized = path
    .replace(/\/+/g, "/")
    .replace(/:([A-Za-z0-9_]+)/g, (_match, param: string) => {
      params.push(param);
      return `[${param}]`;
    });
  return { path: normalized.startsWith("/") ? normalized : `/${normalized}`, params, dynamic: params.length > 0 };
}

abstract class RuntimeRouteProbeAdapter implements StackAdapter {
  abstract readonly id: "express" | "hono";
  abstract readonly stack: "express" | "hono";

  async detect(repoPath: string): Promise<RepoScan | null> {
    const packageJson = await readPackageJson(repoPath);
    const deps = dependencyNames(packageJson);
    const entry = await routeProbeEntryFor(repoPath);
    const configuredStack = configuredRouteProbeStack(packageJson);
    if (!deps.includes(this.stack) && configuredStack !== this.stack) return null;
    const evidence: string[] = [];
    if (deps.includes(this.stack)) evidence.push(`package.json:${this.stack}`);
    if (configuredStack === this.stack) evidence.push(`route-probe-stack:${this.stack}`);
    if (entry) evidence.push(`route-probe:${toPosix(relative(repoPath, entry))}`);
    if (evidence.length === 0) return null;

    const files = await walkFiles(repoPath);
    return repoScan(repoPath, this.stack, files, this.id, evidence);
  }

  async discover(repo: RepoScan, options: DiscoveryOptions = {}): Promise<DiscoveryReport> {
    const result = await runRouteProbe(repo, options);
    const degradations = result.degradation ? [result.degradation] : [];
    const surfaces = result.routes.map((routeInfo) => {
      const route = routeFromRuntimePath(routeInfo.path);
      const requiresAuth = routeInfo.requiresAuth ?? (requiresAuthFromSource("", route.path) || route.path.includes("/projects"));
      return baseSurface({
        id: `${this.stack}.route.${slug(route.path)}.${surfaceHash([route.path, routeInfo.methods.join(",")])}`,
        name: `${titleFromRoute(route.path)} ${this.stack} route`,
        stack: this.stack,
        route,
        methods: routeInfo.methods,
        kind: "api",
        mutationTier: "rest",
        requiresAuth,
        evidence: [routeEvidence(routeInfo.path, "runtime-route-probe")]
      });
    });
    return { adapter: this.id, stack: this.stack, repo, surfaces: sortSurfaces(surfaces), degradations };
  }

  mutationTier(surface: Surface): MutationTier {
    return surface.kind === "api" || surface.kind === "resource-route" ? "rest" : "browser-only";
  }

  async bootForEgress(env: GhostEnv): Promise<AppHandle> {
    const command = env.command ?? "GHOST_ROUTE_PROBE=1 npm start";
    return {
      mode: "container-firewall",
      command: buildContainerFirewallRunCommand({
        command,
        containerPort: env.port ?? 3000,
        hostPort: env.port ?? 3000,
        workspace: env.projectRoot
      }),
      notes: [`${this.stack} runtime route probing boots user code inside the container-firewall egress boundary.`]
    };
  }
}

export class ExpressAdapter extends RuntimeRouteProbeAdapter {
  readonly id = "express" as const;
  readonly stack = "express" as const;
}

export class HonoAdapter extends RuntimeRouteProbeAdapter {
  readonly id = "hono" as const;
  readonly stack = "hono" as const;
}
