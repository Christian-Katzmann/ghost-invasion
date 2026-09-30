import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Finding } from "./schemas/finding.js";
import type { ReportJson } from "./schemas/report.js";
import { resolveReportRunRoot } from "./reporter.js";

export type TriageToolName = "ghost_list_findings" | "ghost_get_finding_evidence" | "ghost_filter_findings";

export interface TriageToolDefinition {
  name: TriageToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
}

export interface TriageToolContext {
  projectRoot?: string;
}

interface TriageFilters {
  run?: string;
  severity?: Finding["severity"];
  category?: Finding["category"];
  invariant?: string;
  routeIncludes?: string;
  limit?: number;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export const triageToolDefinitions: TriageToolDefinition[] = [
  {
    name: "ghost_list_findings",
    description: "Read-only list of findings from a completed Ghost Invasion run.",
    inputSchema: filterInputSchema(),
    annotations: readOnlyAnnotations
  },
  {
    name: "ghost_get_finding_evidence",
    description: "Read-only evidence paths for one finding from a completed Ghost Invasion run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["findingId"],
      properties: {
        run: { type: "string", description: "Run id, run directory, or report.json path. Defaults to the latest report." },
        findingId: { type: "string" }
      }
    },
    annotations: readOnlyAnnotations
  },
  {
    name: "ghost_filter_findings",
    description: "Read-only filtered findings by severity, invariant, category, route, or run.",
    inputSchema: filterInputSchema(),
    annotations: readOnlyAnnotations
  }
];

export function triageMcpManifest(): Record<string, unknown> {
  return {
    name: "ghost-invasion-triage",
    description: "Read-only MCP triage facade over Ghost Invasion run artifacts.",
    tools: triageToolDefinitions
  };
}

export async function callTriageTool(name: string, args: Record<string, unknown> = {}, context: TriageToolContext = {}): Promise<unknown> {
  const projectRoot = resolve(context.projectRoot ?? process.cwd());
  if (name === "ghost_list_findings" || name === "ghost_filter_findings") {
    return listFindings(projectRoot, coerceFilters(args));
  }
  if (name === "ghost_get_finding_evidence") {
    const findingId = stringArg(args.findingId, "findingId");
    return getFindingEvidence(projectRoot, { run: optionalString(args.run), findingId });
  }
  throw new Error(`Unknown read-only Ghost Invasion triage tool: ${name}`);
}

export async function listFindings(projectRoot: string, filters: TriageFilters = {}): Promise<Record<string, unknown>> {
  const artifacts = await readRunArtifacts(projectRoot, filters.run);
  const findings = applyFilters(artifacts.report.findings, filters).map((finding) => summarizeFinding(finding));
  return {
    runId: artifacts.report.runId,
    runRoot: artifacts.runRoot,
    reportPath: join(artifacts.runRoot, "report.json"),
    events: artifacts.events,
    filters: compactObject(filters),
    findings
  };
}

export async function getFindingEvidence(
  projectRoot: string,
  options: { run?: string; findingId: string }
): Promise<Record<string, unknown>> {
  const artifacts = await readRunArtifacts(projectRoot, options.run);
  const finding = artifacts.report.findings.find((candidate) => candidate.id === options.findingId);
  if (!finding) {
    throw new Error(`Finding ${options.findingId} was not found in ${join(artifacts.runRoot, "report.json")}`);
  }

  const evidence = await Promise.all(
    [...finding.evidence, finding.reproSteps, finding.generatedTest]
      .concat(finding.minimalRepro ? [finding.minimalRepro] : [])
      .map((relativePath) => evidencePath(artifacts.runRoot, relativePath))
  );

  return {
    runId: artifacts.report.runId,
    runRoot: artifacts.runRoot,
    finding: summarizeFinding(finding),
    evidence,
    events: artifacts.events
  };
}

async function readRunArtifacts(projectRoot: string, run?: string): Promise<{
  runRoot: string;
  report: ReportJson;
  events: { path: string; count: number; types: string[] };
}> {
  const runRoot = await resolveReportRunRoot(projectRoot, run);
  const report = JSON.parse(await readFile(join(runRoot, "report.json"), "utf8")) as ReportJson;
  const events = await readEventSummary(runRoot);
  return { runRoot, report, events };
}

async function readEventSummary(runRoot: string): Promise<{ path: string; count: number; types: string[] }> {
  const eventsPath = join(runRoot, "events.jsonl");
  const body = await readFile(eventsPath, "utf8").catch(() => "");
  const types = new Set<string>();
  let count = 0;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    count += 1;
    try {
      const parsed = JSON.parse(line) as { type?: unknown };
      if (typeof parsed.type === "string") types.add(parsed.type);
    } catch {
      types.add("unparseable");
    }
  }
  return { path: eventsPath, count, types: [...types].sort() };
}

function applyFilters(findings: Finding[], filters: TriageFilters): Finding[] {
  let filtered = findings;
  if (filters.severity) filtered = filtered.filter((finding) => finding.severity === filters.severity);
  if (filters.category) filtered = filtered.filter((finding) => finding.category === filters.category);
  if (filters.invariant) filtered = filtered.filter((finding) => finding.invariant === filters.invariant);
  if (filters.routeIncludes) filtered = filtered.filter((finding) => finding.affected.route.includes(filters.routeIncludes!));
  return filtered.slice(0, positiveLimit(filters.limit));
}

function summarizeFinding(finding: Finding): Record<string, unknown> {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    confidence: finding.confidence,
    invariant: finding.invariant,
    route: finding.affected.route,
    api: finding.affected.api ?? null,
    reproductionRate: finding.reproductionRate,
    evidenceCount: finding.evidence.length,
    reproSteps: finding.reproSteps,
    generatedTest: finding.generatedTest,
    minimalRepro: finding.minimalRepro
  };
}

async function evidencePath(runRoot: string, relativePath: string): Promise<Record<string, unknown>> {
  const absolutePath = resolve(runRoot, relativePath);
  const safeRunRoot = resolve(runRoot);
  const insideRun = absolutePath === safeRunRoot || absolutePath.startsWith(`${safeRunRoot}/`);
  const exists = insideRun ? Boolean(await stat(absolutePath).catch(() => null)) : false;
  return {
    relativePath,
    absolutePath,
    kind: evidenceKind(relativePath),
    insideRun,
    exists
  };
}

function evidenceKind(path: string): string {
  if (path.endsWith("trace.zip")) return "trace";
  if (path.endsWith("video.webm")) return "video";
  if (path.endsWith(".har")) return "har";
  if (path.endsWith(".png")) return "screenshot";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".ts")) return "test";
  return "artifact";
}

function coerceFilters(args: Record<string, unknown>): TriageFilters {
  return {
    run: optionalString(args.run),
    severity: optionalString(args.severity) as Finding["severity"] | undefined,
    category: optionalString(args.category) as Finding["category"] | undefined,
    invariant: optionalString(args.invariant),
    routeIncludes: optionalString(args.routeIncludes),
    limit: typeof args.limit === "number" ? args.limit : args.limit ? Number.parseInt(String(args.limit), 10) : undefined
  };
}

function filterInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      run: { type: "string", description: "Run id, run directory, or report.json path. Defaults to the latest report." },
      severity: { enum: ["critical", "high", "medium", "low", "info"] },
      category: { enum: ["confirmed-bug", "needs-human-review", "suspicious", "flaky", "suppressed"] },
      invariant: { type: "string" },
      routeIncludes: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 }
    }
  };
}

function positiveLimit(limit: number | undefined): number {
  return Number.isFinite(limit) && limit! > 0 ? Math.min(Math.floor(limit!), 200) : 200;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArg(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${name} is required`);
}

function compactObject(input: TriageFilters): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
