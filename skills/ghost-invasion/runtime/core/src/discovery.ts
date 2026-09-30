// ===========================================================================
// discovery.ts — static surface discovery: turn a project on disk into the set
// of routes/actions/endpoints ("surfaces") the swarm will exercise.
//
// Responsibility: detect the stack, then per-adapter enumerate surfaces from the
// filesystem + TypeScript AST + framework build manifests, recording honest
// degradations when evidence is incomplete. Runtime-only stacks (Express/Hono)
// are handled by the route-probe submodule (./discovery/route-probe.ts).
//
// Safety obligations: discovery is static-analysis only — it reads source, it
// does not mutate the target. The one place it boots user code (adapter
// `bootForEgress`) does so exclusively inside the container-firewall egress
// boundary (buildContainerFirewallRunCommand).
//
// Schemas: produces Surface[] (schemas/surface.ts) and RepoScan
// (schemas/repo-scan.ts); the artifacts are written by writeDiscoveryArtifacts.
//
// Major sections carry `// === <section> ===` landmarks: Types & interfaces ·
// Repo scan & path helpers · TypeScript AST helpers · Surface construction ·
// Filesystem adapters · Adapter registry & scanProject · Artifact rendering.
// ===========================================================================
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import { ExpressAdapter, HonoAdapter } from "./discovery/route-probe.js";
import { buildContainerFirewallRunCommand } from "./egress.js";
import { ensureGhostLayout } from "./ghost-layout.js";
import type { RepoScan } from "./schemas/repo-scan.js";
import type { Surface } from "./schemas/surface.js";

// === Types & interfaces: StackAdapter contract, discovery options/reports ===
export type RawSurface = Surface;
export type MutationTier = Surface["mutationTier"];

export interface GhostEnv {
  projectRoot: string;
  command?: string;
  port?: number;
  egress?: "container-firewall" | "attach-only";
}

export interface AppHandle {
  mode: "container-firewall" | "attach-only";
  command: string[];
  notes: string[];
}

export type StackAdapterId = "sveltekit" | "next-app" | "next-pages" | "express" | "hono" | "vite-react" | "remix" | "nuxt";

export interface StackAdapter {
  id: StackAdapterId;
  stack: RepoScan["stacks"][number];
  detect(repoPath: string): Promise<RepoScan | null>;
  discover(repo: RepoScan, options?: DiscoveryOptions): Promise<DiscoveryReport>;
  mutationTier(surface: Surface): MutationTier;
  bootForEgress(env: GhostEnv): Promise<AppHandle | null>;
}

export interface DiscoveryOptions {
  runBuild?: boolean;
  buildCommand?: string;
  buildTimeoutMs?: number;
  routeProbeCommand?: string;
  routeProbeTimeoutMs?: number;
}

export interface DiscoveryDegradation {
  code: string;
  message: string;
  evidence: string[];
}

export interface DiscoveryReport {
  adapter: StackAdapter["id"];
  stack: RepoScan["stacks"][number];
  repo: RepoScan;
  surfaces: Surface[];
  degradations: DiscoveryDegradation[];
}

export interface ScanProjectOptions extends DiscoveryOptions {
  adapter?: "auto" | StackAdapterId;
  projectRoot?: string;
}

export interface ScanProjectResult {
  scannedAt: string;
  projectRoot: string;
  reports: DiscoveryReport[];
  surfaces: Surface[];
  degradations: DiscoveryDegradation[];
}

export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
export const httpMethodSet = new Set<string>(httpMethods);

const ignoredDirs = new Set(["node_modules", ".git", ".ghost", "dist", "build", ".next", ".svelte-kit", ".nuxt", ".output"]);

// === Repo scan & path helpers (several exported for the route-probe submodule) ===
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function walkFiles(root: string, options: { includeGenerated?: boolean } = {}): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (entries === null) return;

    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!options.includeGenerated && ignoredDirs.has(entry.name)) continue;
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await visit(root);
  return files.sort();
}

function packageManagerFor(_projectRoot: string): RepoScan["packageManager"] {
  return "npm";
}

export async function readPackageJson(projectRoot: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function dependencyNames(packageJson: Record<string, unknown> | null): string[] {
  if (!packageJson) return [];
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = packageJson[field];
    if (deps && typeof deps === "object") {
      for (const key of Object.keys(deps)) names.add(key);
    }
  }
  return [...names];
}

export function repoScan(projectRoot: string, stack: RepoScan["stacks"][number], files: string[], adapter: StackAdapterId, evidence: string[]): RepoScan {
  return {
    $schema: "ghost-invasion/repo-scan@1",
    schemaVersion: "1.0",
    scannedAt: new Date().toISOString(),
    rootPath: projectRoot,
    packageManager: packageManagerFor(projectRoot),
    stacks: [stack],
    files: files.map((path) => ({ path: toPosix(relative(projectRoot, path)), kind: kindForPath(path) })),
    envSignals: [],
    adapters: [{ id: adapter, confidence: 1, evidence }]
  };
}

function kindForPath(path: string): string {
  const name = basename(path);
  if (name === "package.json") return "package-json";
  if (name === "svelte.config.js") return "svelte-config";
  if (name === "next.config.js" || name === "next.config.mjs" || name === "next.config.ts") return "next-config";
  if (name === "vite.config.js" || name === "vite.config.mjs" || name === "vite.config.ts") return "vite-config";
  if (name === "remix.config.js" || name === "remix.config.mjs" || name === "react-router.config.ts") return "remix-config";
  if (name === "nuxt.config.js" || name === "nuxt.config.mjs" || name === "nuxt.config.ts") return "nuxt-config";
  if (name === "middleware.ts" || name === "middleware.js") return "middleware";
  if (name === "route.ts" || name === "route.js") return "next-route-handler";
  if (name.endsWith(".vue")) return "nuxt-page";
  if (name.startsWith("[") || name === "index.tsx" || name === "index.jsx" || name === "index.ts" || name === "index.js") return "next-page";
  if (name === "+server.ts" || name === "+server.js") return "sveltekit-server-route";
  if (name === "+page.server.ts" || name === "+page.server.js") return "sveltekit-page-server";
  return "source";
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function slug(input: string): string {
  const normalized = input
    .replace(/\[\[?\.{3}([^\]]+)\]\]?/g, "$1")
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/[^a-zA-Z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  return normalized || "root";
}

export function titleFromRoute(path: string): string {
  if (path === "/") return "Home";
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/^\[|\]$/g, ""))
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function routePathFromSegments(segments: string[]): { path: string; params: string[]; dynamic: boolean } {
  const params: string[] = [];
  const parts = segments.map((segment) => {
    const restOptional = segment.match(/^\[\[\.\.\.(.+)\]\]$/);
    if (restOptional) {
      params.push(restOptional[1]);
      return `[[...${restOptional[1]}]]`;
    }
    const rest = segment.match(/^\[\.\.\.(.+)\]$/);
    if (rest) {
      params.push(rest[1]);
      return `[...${rest[1]}]`;
    }
    const dynamic = segment.match(/^\[(.+)\]$/);
    if (dynamic) {
      params.push(dynamic[1]);
      return `[${dynamic[1]}]`;
    }
    const group = segment.match(/^\((.+)\)$/);
    if (group) return "";
    return segment;
  });
  const clean = parts.filter(Boolean);
  return { path: `/${clean.join("/")}`.replace(/\/+/g, "/"), params, dynamic: params.length > 0 };
}

function routePathFromPagesFile(pagesRoot: string, file: string): { path: string; params: string[]; dynamic: boolean } {
  const rel = toPosix(relative(pagesRoot, file));
  const withoutExt = rel.replace(/\.(tsx|jsx|ts|js|mjs|cjs)$/, "");
  const segments = withoutExt.split("/").filter(Boolean);
  if (segments.at(-1) === "index") segments.pop();
  return routePathFromSegments(segments);
}

async function findNextPagesRoot(projectRoot: string): Promise<string | null> {
  for (const candidate of [join(projectRoot, "pages"), join(projectRoot, "src", "pages")]) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

// === TypeScript AST helpers: parse source, read exports/actions/auth signals ===
function createSourceFile(path: string, source: string): ts.SourceFile {
  const lower = path.toLowerCase();
  const scriptKind = lower.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : lower.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function exportedFunctionNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      names.push(statement.name.text);
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }

  return names;
}

function hasDefaultExport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) return true;
    if (!ts.canHaveModifiers(statement)) return false;
    const modifiers = ts.getModifiers(statement);
    return Boolean(
      modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    );
  });
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function hasUseServerDirective(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    if (!ts.isStringLiteral(statement.expression)) return false;
    return statement.expression.text === "use server";
  });
}

function exportedActions(sourceFile: ts.SourceFile): string[] {
  const actions = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "actions" || !declaration.initializer) continue;
      for (const key of collectActionKeys(declaration.initializer)) actions.add(key);
    }
  }

  return [...actions];
}

function collectActionKeys(node: ts.Node): string[] {
  const target = ts.isSatisfiesExpression(node) || ts.isAsExpression(node) ? node.expression : node;
  if (!ts.isObjectLiteralExpression(target)) return [];
  const keys: string[] = [];
  for (const property of target.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue;
    const name = property.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      keys.push(name.text);
    }
  }
  return keys;
}

export function surfaceHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}

function methodsFromExports(sourceFile: ts.SourceFile): string[] {
  return exportedFunctionNames(sourceFile).filter((name) => httpMethodSet.has(name)).sort();
}

function methodsFromPagesApiSource(source: string, sourceFile: ts.SourceFile): string[] {
  const methods = new Set(methodsFromExports(sourceFile));
  for (const method of httpMethods) {
    const quoted = new RegExp(`["'\`]${method}["'\`]`);
    if (quoted.test(source)) methods.add(method);
  }
  if (methods.size === 0) {
    return /\breq\.method\b|\brequest\.method\b/.test(source) ? ["GET", "POST", "PUT", "PATCH", "DELETE"] : ["GET"];
  }
  return httpMethods.filter((method) => methods.has(method));
}

export function requiresAuthFromSource(source: string, routePath: string): boolean {
  if (routePath.includes("/login")) return false;
  return /\blocals\.userId\b|\bcookies\(\)|\bcookies\.get\b|\bcookieStore\b|\bheaders\(\)|\buseCookie\b|\bgetCookie\b|\bevent\.context\.user\b|\brequest\.headers\.get\b/.test(
    source
  );
}

function surfaceType(routePath: string, requiresAuth: boolean): Surface["type"] {
  if (routePath.includes("/login") || routePath.includes("/auth")) return "auth";
  if (routePath.includes("/admin")) return "admin";
  if (requiresAuth || routePath.includes("/projects")) return "core";
  return "supporting";
}

function riskFor(routePath: string, kind: Surface["kind"], methods: string[], requiresAuth: boolean): Surface["risk"] {
  if (requiresAuth && routePath.includes("[") && routePath.includes("projects")) return "critical";
  if (kind === "server-action" || kind === "form-post" || methods.some((method) => method !== "GET" && method !== "HEAD")) return "high";
  if (requiresAuth) return "medium";
  return "low";
}

function destructiveFor(methods: string[], kind: Surface["kind"]): boolean {
  return kind === "server-action" || kind === "form-post" || methods.some((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method));
}

export function routeEvidence(ref: string, signal = "filesystem"): Surface["evidence"][number] {
  return { signal, ref, reliable: true };
}

function generatedEvidence(ref: string): Surface["evidence"][number] {
  return { signal: "generated-types", ref, reliable: true };
}

// === Surface construction: build the shared Surface shape from route facts ===
export function baseSurface(input: {
  id: string;
  name: string;
  stack: string;
  route: { path: string; params: string[]; dynamic: boolean };
  methods: string[];
  kind: Surface["kind"];
  mutationTier: MutationTier;
  requiresAuth: boolean;
  evidence: Surface["evidence"];
  inputs?: Surface["inputs"];
}): Surface {
  return {
    $schema: "ghost-invasion/surface@1",
    id: input.id,
    name: input.name,
    type: surfaceType(input.route.path, input.requiresAuth),
    stack: input.stack,
    routes: [input.route],
    methods: input.methods,
    kind: input.kind,
    mutationTier: input.mutationTier,
    requiresAuth: input.requiresAuth,
    requiresRole: input.requiresAuth ? ["member"] : [],
    isDestructive: destructiveFor(input.methods, input.kind),
    integrations: [],
    inputs: input.inputs ?? [],
    risk: riskFor(input.route.path, input.kind, input.methods, input.requiresAuth),
    confidence: { exists: 1 },
    evidence: input.evidence
  };
}

function normalizeRoutePattern(path: string): string {
  const withoutSearch = path.split(/[?#]/)[0] ?? "/";
  const trimmed = withoutSearch.trim();
  if (!trimmed || trimmed === ".") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function combineRoutePaths(parent: string, child: string): string {
  if (!child || child === "." || child === "index") return normalizeRoutePattern(parent || "/");
  if (child.startsWith("/")) return normalizeRoutePattern(child);
  return normalizeRoutePattern(`${normalizeRoutePattern(parent || "/")}/${child}`);
}

function routePathFromWebPattern(path: string): { path: string; params: string[]; dynamic: boolean } {
  const params: string[] = [];
  const normalized = normalizeRoutePattern(path)
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      if (segment === "*") {
        params.push("splat");
        return "[...splat]";
      }
      const rest = segment.match(/^\[\.\.\.(.+)\]$/);
      if (rest) {
        params.push(rest[1]);
        return `[...${rest[1]}]`;
      }
      const bracket = segment.match(/^\[(.+)\]$/);
      if (bracket) {
        params.push(bracket[1]);
        return `[${bracket[1]}]`;
      }
      const colon = segment.match(/^:([A-Za-z0-9_]+)$/);
      if (colon) {
        params.push(colon[1]);
        return `[${colon[1]}]`;
      }
      if (segment.startsWith("$") && segment.length > 1) {
        params.push(segment.slice(1));
        return `[${segment.slice(1)}]`;
      }
      return segment;
    })
    .join("/");
  return { path: normalized || "/", params, dynamic: params.length > 0 };
}

function makeFilesystemSurface(input: {
  stack: string;
  prefix: string;
  route: { path: string; params: string[]; dynamic: boolean };
  ref: string;
  signal?: string;
  reliable?: boolean;
  kind?: Surface["kind"];
  methods?: string[];
  mutationTier?: MutationTier;
  requiresAuth?: boolean;
  inputs?: Surface["inputs"];
}): Surface {
  const reliable = input.reliable ?? true;
  const surface = baseSurface({
    id: `${input.prefix}.${slug(input.route.path)}.${surfaceHash([input.ref, input.methods?.join(",") ?? "GET"])}`,
    name: `${titleFromRoute(input.route.path)} ${input.kind ?? "page"}`,
    stack: input.stack,
    route: input.route,
    methods: input.methods ?? ["GET"],
    kind: input.kind ?? "page",
    mutationTier: input.mutationTier ?? "browser-only",
    requiresAuth: input.requiresAuth ?? requiresAuthFromSource("", input.route.path),
    evidence: [{ signal: input.signal ?? "filesystem", ref: input.ref, reliable }],
    inputs: input.inputs
  });
  if (!reliable) surface.confidence.exists = 0.45;
  return surface;
}

async function svelteGeneratedTypeEvidence(projectRoot: string, routeSegments: string[]): Promise<Surface["evidence"]> {
  const candidates = [
    join(projectRoot, ".svelte-kit", "types", "src", "routes", ...routeSegments, "$types.d.ts"),
    join(projectRoot, ".svelte-kit", "types", "src", "routes", ...routeSegments, "proxy+page.server.ts"),
    join(projectRoot, ".svelte-kit", "types", "src", "routes", ...routeSegments, "proxy+server.ts")
  ];
  const evidence: Surface["evidence"] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      evidence.push(generatedEvidence(toPosix(relative(projectRoot, candidate))));
    }
  }
  if (evidence.length === 0 && (await pathExists(join(projectRoot, ".svelte-kit", "types")))) {
    evidence.push(generatedEvidence(".svelte-kit/types"));
  }
  return evidence;
}

// === Filesystem adapters: one StackAdapter per file-routed framework ===
export class SvelteKitAdapter implements StackAdapter {
  id = "sveltekit" as const;
  stack = "sveltekit" as const;

  async detect(repoPath: string): Promise<RepoScan | null> {
    const packageJson = await readPackageJson(repoPath);
    const deps = dependencyNames(packageJson);
    const evidence: string[] = [];
    if (deps.includes("@sveltejs/kit")) evidence.push("package.json:@sveltejs/kit");
    if (await pathExists(join(repoPath, "svelte.config.js"))) evidence.push("svelte.config.js");
    if (await pathExists(join(repoPath, "src", "routes"))) evidence.push("src/routes");
    if (evidence.length === 0) return null;

    const files = await walkFiles(repoPath);
    return repoScan(repoPath, this.stack, files, this.id, evidence);
  }

  async discover(repo: RepoScan): Promise<DiscoveryReport> {
    const routesRoot = join(repo.rootPath, "src", "routes");
    const files = await walkFiles(routesRoot);
    const surfaces: Surface[] = [];

    for (const file of files) {
      const name = basename(file);
      if (!["+server.ts", "+server.js", "+page.server.ts", "+page.server.js", "+page.svelte"].includes(name)) continue;

      const relDir = dirname(relative(routesRoot, file));
      const routeSegments = relDir === "." ? [] : toPosix(relDir).split("/");
      const route = routePathFromSegments(routeSegments);
      const source = name.endsWith(".svelte") ? "" : await readFile(file, "utf8");
      const sourceFile = source ? createSourceFile(file, source) : null;
      const ref = toPosix(relative(repo.rootPath, file));
      const evidence = [routeEvidence(ref), ...(await svelteGeneratedTypeEvidence(repo.rootPath, routeSegments))];

      if (name.startsWith("+server.") && sourceFile) {
        const methods = methodsFromExports(sourceFile);
        if (methods.length > 0) {
          const requiresAuth = requiresAuthFromSource(source, route.path);
          surfaces.push(
            baseSurface({
              id: `sveltekit.api.${slug(route.path)}.${surfaceHash([ref, methods.join(",")])}`,
              name: `${titleFromRoute(route.path)} API`,
              stack: this.stack,
              route,
              methods,
              kind: "api",
              mutationTier: "rest",
              requiresAuth,
              evidence
            })
          );
        }
      }

      if (name.startsWith("+page.server.") && sourceFile) {
        const actions = exportedActions(sourceFile);
        for (const action of actions) {
          const requiresAuth = requiresAuthFromSource(source, route.path);
          surfaces.push(
            baseSurface({
              id: `sveltekit.form.${slug(route.path)}.${slug(action)}`,
              name: `${titleFromRoute(route.path)} form action ${action}`,
              stack: this.stack,
              route,
              methods: ["POST"],
              kind: "form-post",
              mutationTier: "form-post",
              requiresAuth,
              evidence: [...evidence, { signal: "ast:actions", ref: `${ref}:actions.${action}`, reliable: true }],
              inputs: [{ name: action, type: "FormData", required: true, source: "sveltekit-actions" }]
            })
          );
        }
      }

      if (name === "+page.svelte" || name.startsWith("+page.server.")) {
        const pageId = `sveltekit.page.${slug(route.path)}`;
        if (!surfaces.some((surface) => surface.id === pageId)) {
          const requiresAuth = source ? requiresAuthFromSource(source, route.path) : route.path.includes("/projects");
          surfaces.push(
            baseSurface({
              id: pageId,
              name: `${titleFromRoute(route.path)} page`,
              stack: this.stack,
              route,
              methods: ["GET"],
              kind: "page",
              mutationTier: "browser-only",
              requiresAuth,
              evidence
            })
          );
        }
      }
    }

    return { adapter: this.id, stack: this.stack, repo, surfaces: sortSurfaces(surfaces), degradations: [] };
  }

  mutationTier(surface: Surface): MutationTier {
    if (surface.kind === "api" || surface.kind === "resource-route") return "rest";
    if (surface.kind === "form-post") return "form-post";
    return surface.kind === "server-action" ? "server-action" : "browser-only";
  }

  async bootForEgress(env: GhostEnv): Promise<AppHandle> {
    const command = env.command ?? "npm run build && npm run preview -- --host 127.0.0.1";
    return {
      mode: "container-firewall",
      command: buildContainerFirewallRunCommand({
        command,
        containerPort: env.port ?? 4173,
        hostPort: env.port ?? 4173,
        workspace: env.projectRoot
      }),
      notes: ["SvelteKit boot is intended to run inside the Step 1.2 internal Docker network."]
    };
  }
}

export class NextAppRouterAdapter implements StackAdapter {
  id = "next-app" as const;
  stack = "next-app" as const;

  async detect(repoPath: string): Promise<RepoScan | null> {
    const packageJson = await readPackageJson(repoPath);
    const deps = dependencyNames(packageJson);
    const evidence: string[] = [];
    const hasAppDir = await pathExists(join(repoPath, "app"));
    if (!hasAppDir) return null;
    if (deps.includes("next") && hasAppDir) evidence.push("package.json:next");
    if (hasAppDir) evidence.push("app/");
    if (await pathExists(join(repoPath, "next.config.js"))) evidence.push("next.config.js");
    if (await pathExists(join(repoPath, "next.config.mjs"))) evidence.push("next.config.mjs");
    if (evidence.length === 0) return null;

    const files = await walkFiles(repoPath);
    return repoScan(repoPath, this.stack, files, this.id, evidence);
  }

  async discover(repo: RepoScan, options: DiscoveryOptions = {}): Promise<DiscoveryReport> {
    const appRoot = join(repo.rootPath, "app");
    const files = await walkFiles(appRoot);
    const surfaces: Surface[] = [];
    const degradations: DiscoveryDegradation[] = [];

    for (const file of files) {
      const name = basename(file);
      if (!["route.ts", "route.js", "page.tsx", "page.jsx", "actions.ts", "actions.js"].includes(name)) continue;

      const relDir = dirname(relative(appRoot, file));
      const routeSegments = relDir === "." ? [] : toPosix(relDir).split("/");
      const route = routePathFromSegments(routeSegments);
      const source = await readFile(file, "utf8");
      const sourceFile = createSourceFile(file, source);
      const ref = toPosix(relative(repo.rootPath, file));
      const evidence = [routeEvidence(ref)];

      if (name === "route.ts" || name === "route.js") {
        const methods = methodsFromExports(sourceFile);
        if (methods.length > 0) {
          const requiresAuth = requiresAuthFromSource(source, route.path);
          surfaces.push(
            baseSurface({
              id: `next.route.${slug(route.path)}.${surfaceHash([ref, methods.join(",")])}`,
              name: `${titleFromRoute(route.path)} route handler`,
              stack: this.stack,
              route,
              methods,
              kind: "api",
              mutationTier: "rest",
              requiresAuth,
              evidence
            })
          );
        }
      }

      if (hasUseServerDirective(sourceFile)) {
        for (const action of exportedFunctionNames(sourceFile).filter((name) => !httpMethodSet.has(name))) {
          surfaces.push(
            baseSurface({
              id: `next.server-action.${slug(route.path)}.${slug(action)}`,
              name: `${titleFromRoute(route.path)} server action ${action}`,
              stack: this.stack,
              route,
              methods: ["POST"],
              kind: "server-action",
              mutationTier: "server-action",
              requiresAuth: true,
              evidence: [...evidence, { signal: "ast:use-server", ref: `${ref}:${action}`, reliable: true }],
              inputs: [{ name: action, type: "FormData", required: true, source: "next-server-action" }]
            })
          );
        }
      }

      if (name === "page.tsx" || name === "page.jsx") {
        const requiresAuth = requiresAuthFromSource(source, route.path) || route.path.includes("/projects");
        surfaces.push(
          baseSurface({
            id: `next.page.${slug(route.path)}`,
            name: `${titleFromRoute(route.path)} page`,
            stack: this.stack,
            route,
            methods: ["GET"],
            kind: "page",
            mutationTier: "browser-only",
            requiresAuth,
            evidence
          })
        );
      }
    }

    const middlewareRef = await middlewareEvidence(repo.rootPath);
    if (middlewareRef) {
      surfaces.forEach((surface) => {
        surface.evidence.push({ signal: "middleware-ast", ref: middlewareRef, reliable: true });
        if (surface.requiresAuth) surface.confidence.requiresAuth = Math.max(surface.confidence.requiresAuth ?? 0, 0.8);
      });
    }

    if (options.runBuild ?? true) {
      const build = await runNextBuild(repo.rootPath, options);
      if (build.ok) {
        const manifestScan = await readNextManifests(repo.rootPath);
        surfaces.forEach((surface) => {
          const manifestEvidence = evidenceForSurfaceFromNextManifests(surface, manifestScan);
          for (const evidenceItem of manifestEvidence) surface.evidence.push(evidenceItem);
          if (manifestEvidence.length > 0) {
            surface.confidence.manifest = 1;
          } else if (surface.kind === "page" || surface.kind === "api" || surface.kind === "server-action") {
            degradations.push({
              code: "next-manifest-gap",
              message: `next build completed, but ${surface.id} was not corroborated by build manifests.`,
              evidence: [surface.evidence[0]?.ref ?? surface.id]
            });
          }
        });
      } else {
        degradations.push({
          code: "next-build-failed",
          message: "next build failed; discovery degraded to filesystem plus AST/scout-fill surfaces.",
          evidence: [build.detail]
        });
      }
    }

    return { adapter: this.id, stack: this.stack, repo, surfaces: sortSurfaces(surfaces), degradations };
  }

  mutationTier(surface: Surface): MutationTier {
    if (surface.kind === "server-action") return "server-action";
    if (surface.kind === "api" || surface.kind === "resource-route") return "rest";
    return "browser-only";
  }

  async bootForEgress(env: GhostEnv): Promise<AppHandle> {
    const command = env.command ?? "NEXT_TELEMETRY_DISABLED=1 npm run build && npm run start -- --hostname 127.0.0.1";
    return {
      mode: "container-firewall",
      command: buildContainerFirewallRunCommand({
        command,
        containerPort: env.port ?? 3000,
        hostPort: env.port ?? 3000,
        workspace: env.projectRoot
      }),
      notes: ["Next build/start must run in the Step 1.2 internal Docker network because App Router build can execute user code."]
    };
  }
}

export class NextPagesRouterAdapter implements StackAdapter {
  id = "next-pages" as const;
  stack = "next-pages" as const;

  async detect(repoPath: string): Promise<RepoScan | null> {
    const packageJson = await readPackageJson(repoPath);
    const deps = dependencyNames(packageJson);
    const pagesRoot = await findNextPagesRoot(repoPath);
    if (!pagesRoot) return null;

    const evidence: string[] = [];
    if (deps.includes("next")) evidence.push("package.json:next");
    evidence.push(toPosix(relative(repoPath, pagesRoot)) || "pages");
    if (await pathExists(join(repoPath, "next.config.js"))) evidence.push("next.config.js");
    if (await pathExists(join(repoPath, "next.config.mjs"))) evidence.push("next.config.mjs");

    const files = await walkFiles(repoPath);
    return repoScan(repoPath, this.stack, files, this.id, evidence);
  }

  async discover(repo: RepoScan): Promise<DiscoveryReport> {
    const pagesRoot = await findNextPagesRoot(repo.rootPath);
    const files = pagesRoot ? await walkFiles(pagesRoot) : [];
    const surfaces: Surface[] = [];

    for (const file of files) {
      const name = basename(file);
      if (!/\.(tsx|jsx|ts|js|mjs|cjs)$/.test(name)) continue;
      if (name.startsWith("_")) continue;

      const rel = toPosix(relative(pagesRoot ?? repo.rootPath, file));
      const segments = rel.split("/");
      const route = routePathFromPagesFile(pagesRoot ?? repo.rootPath, file);
      const source = await readFile(file, "utf8");
      const sourceFile = createSourceFile(file, source);
      const ref = toPosix(relative(repo.rootPath, file));
      const evidence = [routeEvidence(ref)];

      if (segments[0] === "api") {
        const methods = methodsFromPagesApiSource(source, sourceFile);
        const requiresAuth = requiresAuthFromSource(source, route.path);
        surfaces.push(
          baseSurface({
            id: `next-pages.api.${slug(route.path)}.${surfaceHash([ref, methods.join(",")])}`,
            name: `${titleFromRoute(route.path)} pages API`,
            stack: this.stack,
            route,
            methods,
            kind: "api",
            mutationTier: "rest",
            requiresAuth,
            evidence
          })
        );
        continue;
      }

      const requiresAuth = requiresAuthFromSource(source, route.path) || route.path.includes("/projects");
      surfaces.push(
        baseSurface({
          id: `next-pages.page.${slug(route.path)}`,
          name: `${titleFromRoute(route.path)} page`,
          stack: this.stack,
          route,
          methods: ["GET"],
          kind: "page",
          mutationTier: "browser-only",
          requiresAuth,
          evidence
        })
      );
    }

    return { adapter: this.id, stack: this.stack, repo, surfaces: sortSurfaces(surfaces), degradations: [] };
  }

  mutationTier(surface: Surface): MutationTier {
    if (surface.kind === "api" || surface.kind === "resource-route") return "rest";
    return surface.kind === "server-action" ? "server-action" : "browser-only";
  }

  async bootForEgress(env: GhostEnv): Promise<AppHandle> {
    const command = env.command ?? "NEXT_TELEMETRY_DISABLED=1 npm run build && npm run start -- --hostname 127.0.0.1";
    return {
      mode: "container-firewall",
      command: buildContainerFirewallRunCommand({
        command,
        containerPort: env.port ?? 3000,
        hostPort: env.port ?? 3000,
        workspace: env.projectRoot
      }),
      notes: ["Next Pages boot uses the same container-firewall boundary as the App Router adapter."]
    };
  }
}

interface StaticRouteCandidate {
  path: string;
  ref: string;
  signal: string;
  reliable: boolean;
}

function propertyByName(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = property.name;
    if ((ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) && propertyName.text === name) {
      return property.initializer;
    }
  }
  return undefined;
}

function booleanProperty(node: ts.ObjectLiteralExpression, name: string): boolean {
  const value = propertyByName(node, name);
  return value?.kind === ts.SyntaxKind.TrueKeyword;
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function addRouteCandidate(candidates: Map<string, StaticRouteCandidate>, candidate: StaticRouteCandidate): void {
  const normalized = normalizeRoutePattern(candidate.path);
  const existing = candidates.get(normalized);
  if (!existing || (!existing.reliable && candidate.reliable)) {
    candidates.set(normalized, { ...candidate, path: normalized });
  }
}

function collectObjectRoutes(node: ts.Node, parentPath: string, candidates: Map<string, StaticRouteCandidate>, ref: string): void {
  if (!ts.isObjectLiteralExpression(node)) return;
  const path = literalText(propertyByName(node, "path"));
  const index = booleanProperty(node, "index");
  const currentPath = path !== null ? combineRoutePaths(parentPath, path) : index ? normalizeRoutePattern(parentPath || "/") : parentPath;

  if (path !== null || index) {
    addRouteCandidate(candidates, { path: currentPath, ref, signal: "ast:router-config", reliable: true });
  }

  const children = propertyByName(node, "children");
  if (children && ts.isArrayLiteralExpression(children)) {
    for (const child of children.elements) collectObjectRoutes(child, currentPath, candidates, ref);
  }
}

function jsxTagName(node: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(node)) return node.text;
  return node.getText();
}

function jsxAttributeName(node: ts.JsxAttributeName): string {
  if (ts.isIdentifier(node)) return node.text;
  return `${node.namespace.text}:${node.name.text}`;
}

function jsxStringAttribute(attributes: ts.JsxAttributes, name: string): string | null {
  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || jsxAttributeName(property.name) !== name || !property.initializer) continue;
    if (ts.isStringLiteral(property.initializer)) return property.initializer.text;
    if (ts.isJsxExpression(property.initializer)) return literalText(property.initializer.expression);
  }
  return null;
}

function jsxBooleanAttribute(attributes: ts.JsxAttributes, name: string): boolean {
  return attributes.properties.some((property) => ts.isJsxAttribute(property) && jsxAttributeName(property.name) === name && !property.initializer);
}

function collectJsxRouteElements(node: ts.Node, parentPath: string, candidates: Map<string, StaticRouteCandidate>, ref: string): void {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const tagName = jsxTagName(opening.tagName);
    let childParent = parentPath;
    if (tagName === "Route") {
      const path = jsxStringAttribute(opening.attributes, "path");
      const index = jsxBooleanAttribute(opening.attributes, "index");
      childParent = path !== null ? combineRoutePaths(parentPath, path) : index ? normalizeRoutePattern(parentPath || "/") : parentPath;
      if (path !== null || index) {
        addRouteCandidate(candidates, { path: childParent, ref, signal: "ast:jsx-route", reliable: true });
      }
    }
    if (ts.isJsxElement(node)) {
      for (const child of node.children) collectJsxRouteElements(child, childParent, candidates, ref);
      return;
    }
  }

  ts.forEachChild(node, (child) => collectJsxRouteElements(child, parentPath, candidates, ref));
}

function collectStaticLinks(sourceFile: ts.SourceFile, candidates: Map<string, StaticRouteCandidate>, ref: string): void {
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      for (const attrName of ["href", "to"]) {
        const value = jsxStringAttribute(opening.attributes, attrName);
        if (value?.startsWith("/") && !value.startsWith("//")) {
          addRouteCandidate(candidates, { path: value, ref, signal: "crawl-fallback:static-link", reliable: false });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function collectReactRouteCandidates(sourceFile: ts.SourceFile, ref: string): Map<string, StaticRouteCandidate> {
  const candidates = new Map<string, StaticRouteCandidate>();

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) collectObjectRoutes(node, "/", candidates, ref);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "route") {
        const path = literalText(node.arguments[0]);
        if (path !== null) addRouteCandidate(candidates, { path, ref, signal: "ast:router-config", reliable: true });
      }
      if (name === "index") {
        addRouteCandidate(candidates, { path: "/", ref, signal: "ast:router-config", reliable: true });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  collectJsxRouteElements(sourceFile, "/", candidates, ref);
  return candidates;
}

async function candidateSourceFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const files = await walkFiles(root);
  return files.filter((file) => /\.(tsx|jsx|ts|js|mjs|cjs)$/.test(file));
}

export class ViteReactAdapter implements StackAdapter {
  id = "vite-react" as const;
  stack = "vite-react" as const;

  async detect(repoPath: string): Promise<RepoScan | null> {
    const packageJson = await readPackageJson(repoPath);
    const deps = dependencyNames(packageJson);
    const evidence: string[] = [];
    const hasVite = deps.includes("vite") || (await pathExists(join(repoPath, "vite.config.ts"))) || (await pathExists(join(repoPath, "vite.config.js")));
    const hasReact = deps.includes("react") || deps.includes("@vitejs/plugin-react");
    if (!hasVite || !hasReact) return null;
    evidence.push("package.json:vite", "package.json:react");
    if (await pathExists(join(repoPath, "src", "main.tsx"))) evidence.push("src/main.tsx");
    if (await pathExists(join(repoPath, "src", "App.tsx"))) evidence.push("src/App.tsx");

    const files = await walkFiles(repoPath);
    return repoScan(repoPath, this.stack, files, this.id, evidence);
  }

  async discover(repo: RepoScan): Promise<DiscoveryReport> {
    const sources = await candidateSourceFiles(join(repo.rootPath, "src"));
    const reliableRoutes = new Map<string, StaticRouteCandidate>();
    const fallbackRoutes = new Map<string, StaticRouteCandidate>();

    for (const file of sources) {
      const source = await readFile(file, "utf8");
      const sourceFile = createSourceFile(file, source);
      const ref = toPosix(relative(repo.rootPath, file));
      const candidates = collectReactRouteCandidates(sourceFile, ref);
      for (const candidate of candidates.values()) {
        if (candidate.reliable) addRouteCandidate(reliableRoutes, candidate);
      }
      collectStaticLinks(sourceFile, fallbackRoutes, ref);
    }

    const degradations: DiscoveryDegradation[] = [];
    let candidates = [...reliableRoutes.values()];
    let kind: Surface["kind"] = "page";
    if (candidates.length === 0) {
      degradations.push({
        code: "vite-react-crawl-only",
        message: "No React Router config was found; discovery degraded to crawl-only/static-link coverage, which can miss auth-gated SPA routes.",
        evidence: sources.map((file) => toPosix(relative(repo.rootPath, file))).slice(0, 8)
      });
      candidates = [...fallbackRoutes.values()];
      kind = "nav";
    }
    if (candidates.length === 0) {
      candidates = [{ path: "/", ref: "index.html", signal: "crawl-fallback:root", reliable: false }];
      kind = "nav";
    }

    const surfaces = candidates.map((candidate) =>
      makeFilesystemSurface({
        stack: this.stack,
        prefix: "vite-react.page",
        route: routePathFromWebPattern(candidate.path),
        ref: candidate.ref,
        signal: candidate.signal,
        reliable: candidate.reliable,
        kind,
        requiresAuth: requiresAuthFromSource("", candidate.path) || candidate.path.includes("/projects")
      })
    );

    return { adapter: this.id, stack: this.stack, repo, surfaces: sortSurfaces(surfaces), degradations };
  }

  mutationTier(surface: Surface): MutationTier {
    return surface.kind === "api" || surface.kind === "resource-route" ? "rest" : "browser-only";
  }

  async bootForEgress(env: GhostEnv): Promise<AppHandle> {
    const command = env.command ?? "npm run build && npm run preview -- --host 127.0.0.1";
    return {
      mode: "container-firewall",
      command: buildContainerFirewallRunCommand({
        command,
        containerPort: env.port ?? 4173,
        hostPort: env.port ?? 4173,
        workspace: env.projectRoot
      }),
      notes: ["Vite/React preview runs inside the container-firewall egress boundary; SPA fallback discovery may be incomplete."]
    };
  }
}

function routePathFromRemixFile(routesRoot: string, file: string): { path: string; params: string[]; dynamic: boolean } {
  const rel = toPosix(relative(routesRoot, file)).replace(/\.(tsx|jsx|ts|js|mjs|cjs)$/, "");
  const withoutRouteSuffix = rel.replace(/\/route$/, "");
  const rawSegments = withoutRouteSuffix.split("/").flatMap((segment) => segment.split("."));
  const routeSegments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === "_index") continue;
    if (segment.startsWith("_")) continue;
    if (segment === "$") {
      routeSegments.push("[...splat]");
    } else if (segment.startsWith("$")) {
      routeSegments.push(`[${segment.slice(1)}]`);
    } else {
      routeSegments.push(segment);
    }
  }
  return routePathFromSegments(routeSegments);
}

export class RemixAdapter implements StackAdapter {
  id = "remix" as const;
  stack = "remix" as const;

  async detect(repoPath: string): Promise<RepoScan | null> {
    const packageJson = await readPackageJson(repoPath);
    const deps = dependencyNames(packageJson);
    const hasRoutes = (await pathExists(join(repoPath, "app", "routes"))) || (await pathExists(join(repoPath, "app", "routes.ts")));
    const hasRemix = deps.includes("@remix-run/react") || deps.includes("@remix-run/node") || deps.includes("@react-router/dev");
    const hasReactRouterFramework = deps.includes("react-router") && hasRoutes;
    if (!hasRoutes || (!hasRemix && !hasReactRouterFramework)) return null;

    const evidence: string[] = [];
    if (hasRemix) evidence.push("package.json:@remix-run/react");
    if (hasReactRouterFramework) evidence.push("package.json:react-router");
    evidence.push("app/routes");

    const files = await walkFiles(repoPath);
    return repoScan(repoPath, this.stack, files, this.id, evidence);
  }

  async discover(repo: RepoScan): Promise<DiscoveryReport> {
    const routesRoot = join(repo.rootPath, "app", "routes");
    const files = await candidateSourceFiles(routesRoot);
    const surfaces: Surface[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const sourceFile = createSourceFile(file, source);
      const ref = toPosix(relative(repo.rootPath, file));
      const route = routePathFromRemixFile(routesRoot, file);
      const exports = new Set(exportedFunctionNames(sourceFile));
      const hasAction = exports.has("action");
      const hasLoader = exports.has("loader");
      const hasDefault = hasDefaultExport(sourceFile);
      const requiresAuth = requiresAuthFromSource(source, route.path) || route.path.includes("/projects");

      if (route.path.startsWith("/api") || (!hasDefault && (hasAction || hasLoader))) {
        const methods = [...(hasLoader ? ["GET"] : []), ...(hasAction ? ["POST"] : [])];
        surfaces.push(
          makeFilesystemSurface({
            stack: this.stack,
            prefix: "remix.resource",
            route,
            ref,
            signal: "filesystem:remix-route",
            kind: "resource-route",
            methods: methods.length > 0 ? methods : ["GET"],
            mutationTier: "rest",
            requiresAuth
          })
        );
        continue;
      }

      if (hasDefault || hasLoader) {
        surfaces.push(
          makeFilesystemSurface({
            stack: this.stack,
            prefix: "remix.page",
            route,
            ref,
            signal: "filesystem:remix-route",
            kind: "page",
            methods: ["GET"],
            requiresAuth
          })
        );
      }

      if (hasAction) {
        surfaces.push(
          makeFilesystemSurface({
            stack: this.stack,
            prefix: "remix.form",
            route,
            ref,
            signal: "ast:remix-action",
            kind: "form-post",
            methods: ["POST"],
            mutationTier: "form-post",
            requiresAuth,
            inputs: [{ name: "action", type: "FormData", required: true, source: "remix-action" }]
          })
        );
      }
    }

    const routeConfigFiles = ["app/routes.ts", "app/routes.tsx", "app/routes.js", "app/routes.jsx"];
    for (const rel of routeConfigFiles) {
      const file = join(repo.rootPath, rel);
      if (!(await pathExists(file))) continue;
      const sourceFile = createSourceFile(file, await readFile(file, "utf8"));
      for (const candidate of collectReactRouteCandidates(sourceFile, rel).values()) {
        if (surfaces.some((surface) => surface.routes[0]?.path === normalizeRoutePattern(candidate.path))) continue;
        surfaces.push(
          makeFilesystemSurface({
            stack: this.stack,
            prefix: "remix.page",
            route: routePathFromWebPattern(candidate.path),
            ref: rel,
            signal: candidate.signal,
            kind: "page",
            methods: ["GET"],
            requiresAuth: candidate.path.includes("/projects")
          })
        );
      }
    }

    return { adapter: this.id, stack: this.stack, repo, surfaces: sortSurfaces(surfaces), degradations: [] };
  }

  mutationTier(surface: Surface): MutationTier {
    if (surface.kind === "resource-route" || surface.kind === "api") return "rest";
    if (surface.kind === "form-post") return "form-post";
    return "browser-only";
  }

  async bootForEgress(env: GhostEnv): Promise<AppHandle> {
    const command = env.command ?? "npm run build && HOST=127.0.0.1 npm run start";
    return {
      mode: "container-firewall",
      command: buildContainerFirewallRunCommand({
        command,
        containerPort: env.port ?? 3000,
        hostPort: env.port ?? 3000,
        workspace: env.projectRoot
      }),
      notes: ["Remix/React Router runtime boot runs user code inside the container-firewall egress boundary."]
    };
  }
}

function routePathFromNuxtPageFile(pagesRoot: string, file: string): { path: string; params: string[]; dynamic: boolean } {
  const rel = toPosix(relative(pagesRoot, file)).replace(/\.(vue|tsx|jsx|ts|js)$/, "");
  const segments = rel.split("/").filter(Boolean);
  if (segments.at(-1) === "index") segments.pop();
  return routePathFromSegments(segments);
}

function nuxtServerRoute(serverRoot: string, file: string): { route: { path: string; params: string[]; dynamic: boolean }; methods: string[] } {
  const rel = toPosix(relative(serverRoot, file)).replace(/\.(ts|js|mjs|cjs)$/, "");
  const segments = rel.split("/").filter(Boolean);
  const first = segments[0];
  const apiPrefix = first === "api" ? ["api"] : [];
  const routeSegments = first === "api" || first === "routes" ? segments.slice(1) : segments;
  const last = routeSegments.at(-1) ?? "index";
  const methodMatch = last.match(/^(.+)\.(get|post|put|patch|delete)$/i);
  const methods = methodMatch ? [methodMatch[2].toUpperCase()] : ["GET"];
  if (methodMatch) routeSegments[routeSegments.length - 1] = methodMatch[1];
  if (routeSegments.at(-1) === "index") routeSegments.pop();
  return { route: routePathFromSegments([...apiPrefix, ...routeSegments]), methods };
}

export class NuxtAdapter implements StackAdapter {
  id = "nuxt" as const;
  stack = "nuxt" as const;

  async detect(repoPath: string): Promise<RepoScan | null> {
    const packageJson = await readPackageJson(repoPath);
    const deps = dependencyNames(packageJson);
    const evidence: string[] = [];
    if (deps.includes("nuxt") || deps.includes("nuxt3")) evidence.push("package.json:nuxt");
    if (await pathExists(join(repoPath, "nuxt.config.ts"))) evidence.push("nuxt.config.ts");
    if (await pathExists(join(repoPath, "nuxt.config.js"))) evidence.push("nuxt.config.js");
    if (await pathExists(join(repoPath, "pages"))) evidence.push("pages/");
    if (evidence.length === 0) return null;

    const files = await walkFiles(repoPath);
    return repoScan(repoPath, this.stack, files, this.id, evidence);
  }

  async discover(repo: RepoScan): Promise<DiscoveryReport> {
    const pagesRoot = join(repo.rootPath, "pages");
    const pages = (await pathExists(pagesRoot) ? await walkFiles(pagesRoot) : []).filter((file) => /\.(vue|tsx|jsx|ts|js)$/.test(file));
    const serverRoot = join(repo.rootPath, "server");
    const serverFiles = await candidateSourceFiles(serverRoot);
    const surfaces: Surface[] = [];

    for (const file of pages) {
      const source = await readFile(file, "utf8");
      const route = routePathFromNuxtPageFile(pagesRoot, file);
      const ref = toPosix(relative(repo.rootPath, file));
      surfaces.push(
        makeFilesystemSurface({
          stack: this.stack,
          prefix: "nuxt.page",
          route,
          ref,
          signal: "filesystem:nuxt-page",
          kind: "page",
          methods: ["GET"],
          requiresAuth: requiresAuthFromSource(source, route.path) || route.path.includes("/projects")
        })
      );
    }

    for (const file of serverFiles) {
      const source = await readFile(file, "utf8");
      const { route, methods } = nuxtServerRoute(serverRoot, file);
      const ref = toPosix(relative(repo.rootPath, file));
      surfaces.push(
        makeFilesystemSurface({
          stack: this.stack,
          prefix: "nuxt.server",
          route,
          ref,
          signal: "filesystem:nuxt-server",
          kind: "api",
          methods,
          mutationTier: "rest",
          requiresAuth: requiresAuthFromSource(source, route.path) || route.path.includes("/projects")
        })
      );
    }

    return { adapter: this.id, stack: this.stack, repo, surfaces: sortSurfaces(surfaces), degradations: [] };
  }

  mutationTier(surface: Surface): MutationTier {
    return surface.kind === "api" || surface.kind === "resource-route" ? "rest" : "browser-only";
  }

  async bootForEgress(env: GhostEnv): Promise<AppHandle> {
    const command = env.command ?? "npm run build && npm run preview -- --host 127.0.0.1";
    return {
      mode: "container-firewall",
      command: buildContainerFirewallRunCommand({
        command,
        containerPort: env.port ?? 3000,
        hostPort: env.port ?? 3000,
        workspace: env.projectRoot
      }),
      notes: ["Nuxt preview runs inside the container-firewall egress boundary."]
    };
  }
}

async function middlewareEvidence(projectRoot: string): Promise<string | null> {
  for (const name of ["middleware.ts", "middleware.js"]) {
    const candidate = join(projectRoot, name);
    if (await pathExists(candidate)) return name;
  }
  return null;
}

async function runNextBuild(projectRoot: string, options: DiscoveryOptions): Promise<{ ok: true } | { ok: false; detail: string }> {
  const buildCommand = options.buildCommand ?? "npm run build";
  const timeoutMs = options.buildTimeoutMs ?? 120_000;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", buildCommand], {
      cwd: projectRoot,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, detail: `command timed out after ${timeoutMs}ms: ${buildCommand}` });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-4000);
    });
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, detail: `${buildCommand} failed to start: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        const elapsed = Date.now() - started;
        resolve({ ok: false, detail: `${buildCommand} exited code=${code ?? "null"} signal=${signal ?? "none"} after ${elapsed}ms\n${output.trim()}` });
      }
    });
  });
}

interface NextManifestScan {
  appPaths: Set<string>;
  serverActions: Set<string>;
  middleware: boolean;
}

async function readNextManifests(projectRoot: string): Promise<NextManifestScan> {
  const appPaths = new Set<string>();
  const serverActions = new Set<string>();
  const appPathsRef = join(projectRoot, ".next", "server", "app-paths-manifest.json");
  const serverReferenceRef = join(projectRoot, ".next", "server", "server-reference-manifest.json");

  if (await pathExists(appPathsRef)) {
    const manifest = JSON.parse(await readFile(appPathsRef, "utf8")) as Record<string, string>;
    for (const key of Object.keys(manifest)) appPaths.add(key);
  }

  if (await pathExists(serverReferenceRef)) {
    const manifest = JSON.parse(await readFile(serverReferenceRef, "utf8")) as {
      node?: Record<string, { filename?: string; exportedName?: string }>;
      edge?: Record<string, { filename?: string; exportedName?: string }>;
    };
    for (const group of [manifest.node, manifest.edge]) {
      if (!group) continue;
      for (const entry of Object.values(group)) {
        if (entry.filename && entry.exportedName) serverActions.add(`${toPosix(entry.filename)}:${entry.exportedName}`);
      }
    }
  }

  return {
    appPaths,
    serverActions,
    middleware: await pathExists(join(projectRoot, ".next", "server", "middleware-manifest.json"))
  };
}

function evidenceForSurfaceFromNextManifests(surface: Surface, manifestScan: NextManifestScan): Surface["evidence"] {
  const evidence: Surface["evidence"] = [];
  const routePath = surface.routes[0]?.path ?? "/";
  const appPathKey = surface.kind === "api" ? `${routePath}/route` : surface.kind === "page" ? `${routePath === "/" ? "" : routePath}/page` : null;

  if (appPathKey && manifestScan.appPaths.has(appPathKey)) {
    evidence.push({ signal: "next-build-manifest", ref: `.next/server/app-paths-manifest.json:${appPathKey}`, reliable: true });
  }

  if (surface.kind === "server-action") {
    const astRef = surface.evidence.find((item) => item.signal === "ast:use-server")?.ref;
    if (astRef) {
      const normalizedAstRef = toPosix(astRef);
      const matched = [...manifestScan.serverActions].find((action) => normalizedAstRef.endsWith(action) || action.endsWith(normalizedAstRef));
      if (matched) {
        evidence.push({ signal: "next-build-manifest", ref: `.next/server/server-reference-manifest.json:${matched}`, reliable: true });
      }
    }
  }

  if (manifestScan.middleware && surface.evidence.some((item) => item.signal === "middleware-ast")) {
    evidence.push({ signal: "next-build-manifest", ref: ".next/server/middleware-manifest.json", reliable: true });
  }

  return evidence;
}

// === Runtime route-probe adapters (Express/Hono) — extracted to
//     ./discovery/route-probe.ts, a distinct seam from the filesystem/AST
//     adapters above. Re-exported here so the registry below and
//     ./discovery.js consumers keep their existing import surface (S-023). ===
export { ExpressAdapter, HonoAdapter } from "./discovery/route-probe.js";

export function sortSurfaces(surfaces: Surface[]): Surface[] {
  return surfaces.sort((a, b) => a.id.localeCompare(b.id));
}

// === Adapter registry & scanProject: the StackAdapter list the runner walks ===
export const stackAdapters: StackAdapter[] = [
  new SvelteKitAdapter(),
  new NextAppRouterAdapter(),
  new NextPagesRouterAdapter(),
  new ExpressAdapter(),
  new HonoAdapter(),
  new ViteReactAdapter(),
  new RemixAdapter(),
  new NuxtAdapter()
];

export async function scanProject(options: ScanProjectOptions = {}): Promise<ScanProjectResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const adapterFilter = options.adapter ?? "auto";
  const reports: DiscoveryReport[] = [];

  for (const adapter of stackAdapters) {
    if (adapterFilter !== "auto" && adapterFilter !== adapter.id) continue;
    const repo = await adapter.detect(projectRoot);
    if (!repo) continue;
    reports.push(await adapter.discover(repo, options));
  }

  const surfaces = reports.flatMap((report) => report.surfaces);
  const degradations = reports.flatMap((report) => report.degradations);
  return { scannedAt: new Date().toISOString(), projectRoot, reports, surfaces, degradations };
}

// === Artifact rendering: write discovered-surfaces.{json,md} for the plan ===
export async function writeDiscoveryArtifacts(result: ScanProjectResult, projectRoot = result.projectRoot): Promise<{ markdownPath: string; jsonPath: string }> {
  const layout = await ensureGhostLayout(projectRoot);
  const markdownPath = join(layout.plan, "discovered-surfaces.md");
  const jsonPath = join(layout.plan, "discovered-surfaces.json");
  await writeFile(markdownPath, renderDiscoveredSurfacesMarkdown(result));
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  return { markdownPath, jsonPath };
}

export function renderDiscoveredSurfacesMarkdown(result: ScanProjectResult): string {
  const lines = ["# Discovered Surfaces", "", `Scanned: ${result.scannedAt}`, `Project: ${result.projectRoot}`, ""];
  for (const report of result.reports) {
    lines.push(`## ${report.adapter}`, "");
    for (const surface of report.surfaces) {
      const route = surface.routes.map((item) => item.path).join(", ");
      lines.push(`- ${surface.id} — ${surface.kind} — ${surface.mutationTier} — ${surface.methods.join(",") || "GET"} — ${route}`);
      lines.push(`  evidence: ${surface.evidence.map((item) => `${item.signal}:${item.ref}${item.reliable ? "" : "?"}`).join("; ")}`);
    }
    if (report.degradations.length > 0) {
      lines.push("", "### Degradations", "");
      for (const degradation of report.degradations) {
        lines.push(`- ${degradation.code}: ${degradation.message}`);
      }
    }
    lines.push("");
  }
  if (result.reports.length === 0) {
    lines.push("No supported stack adapter detected.", "");
  }
  return `${lines.join("\n")}\n`;
}
