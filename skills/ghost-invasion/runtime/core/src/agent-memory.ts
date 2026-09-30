import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";

export interface GhostAgentMemory {
  sourcePath: string;
  facts: Record<string, string>;
}

export interface GhostRunMemoryResult {
  agentsPath: string;
  claudePath: string;
  claudeImportsAgents: boolean;
  facts: Record<string, string>;
}

export const GHOST_MEMORY_START = "<!-- ghost-invasion-memory:start -->";
export const GHOST_MEMORY_END = "<!-- ghost-invasion-memory:end -->";

const FACT_ORDER = [
  "safe_base_url",
  "reset_strategy",
  "auth_roles",
  "default_pack",
  "stable_routes",
  "success_criteria",
  "latest_trusted_report"
];

export async function readGhostAgentMemory(projectRoot: string): Promise<GhostAgentMemory> {
  const agentsPath = join(resolve(projectRoot), "AGENTS.md");
  const body = await readFile(agentsPath, "utf8").catch(() => "");
  return { sourcePath: agentsPath, facts: parseMemoryFacts(body) };
}

export async function appendGhostRunMemory(options: {
  projectRoot: string;
  plan: GhostInvasionPlan;
  runId: string;
  reportPath?: string;
}): Promise<GhostRunMemoryResult> {
  const projectRoot = resolve(options.projectRoot);
  const agentsPath = join(projectRoot, "AGENTS.md");
  const claudePath = join(projectRoot, "CLAUDE.md");
  const existingAgents = await readFile(agentsPath, "utf8").catch(() => "");
  const existingFacts = parseMemoryFacts(existingAgents);
  const nextFacts = {
    ...existingFacts,
    ...factsForPlan(options.plan, {
      projectRoot,
      runId: options.runId,
      reportPath: options.reportPath
    })
  };

  await writeFile(agentsPath, renderAgentsMemory(existingAgents, nextFacts), "utf8");
  const claudeImportsAgents = await ensureClaudeImportsAgents(claudePath);
  return { agentsPath, claudePath, claudeImportsAgents, facts: nextFacts };
}

function factsForPlan(
  plan: GhostInvasionPlan,
  options: { projectRoot: string; runId: string; reportPath?: string }
): Record<string, string> {
  const roles = [...new Set(plan.personas.map((persona) => `${persona.role.name}:${persona.role.authStrategy}`))].sort();
  const routes = [...new Set(plan.journeys.flatMap((journey) => journey.anchors.routes))].sort();
  const criteria = plan.journeys
    .flatMap((journey) =>
      journey.success.map((step) => {
        if (step.type === "expectDbDiff") {
          return `${journey.id}: ${step.table} inserts ${step.expectInserted}`;
        }
        return `${journey.id}: ${step.type}`;
      })
    )
    .slice(0, 8);
  const latestReport = options.reportPath
    ? relative(options.projectRoot, resolve(options.reportPath))
    : join(".ghost", "runs", options.runId, "report.json");

  return {
    safe_base_url: plan.target.baseUrl,
    reset_strategy: `${plan.safety.dataReset.strategy} / ${plan.safety.dataReset.isolation}`,
    auth_roles: roles.join(", ") || "none",
    default_pack: plan.pack,
    stable_routes: routes.slice(0, 12).join(", ") || "none",
    success_criteria: criteria.join("; ") || "none",
    latest_trusted_report: latestReport
  };
}

function renderAgentsMemory(existing: string, facts: Record<string, string>): string {
  const prefix = existing.trim()
    ? existing.trimEnd()
    : [
        "# AGENTS.md",
        "",
        "Repo-local agent memory for Ghost Invasion. Keep this file non-secret and stable.",
        ""
      ].join("\n");
  const section = [
    "## Ghost Invasion Memory",
    "",
    "Durable, non-secret facts the next Ghost Invasion run can reuse.",
    GHOST_MEMORY_START,
    ...orderedFacts(facts).map(([key, value]) => `- ${key}: ${sanitizeFactValue(value)}`),
    GHOST_MEMORY_END
  ].join("\n");

  if (prefix.includes(GHOST_MEMORY_START) && prefix.includes(GHOST_MEMORY_END)) {
    const before = prefix.slice(0, prefix.indexOf(GHOST_MEMORY_START)).trimEnd();
    const after = prefix.slice(prefix.indexOf(GHOST_MEMORY_END) + GHOST_MEMORY_END.length).trimStart();
    return `${before}\n${GHOST_MEMORY_START}\n${orderedFacts(facts)
      .map(([key, value]) => `- ${key}: ${sanitizeFactValue(value)}`)
      .join("\n")}\n${GHOST_MEMORY_END}${after ? `\n\n${after}` : ""}\n`;
  }

  return `${prefix}\n\n${section}\n`;
}

async function ensureClaudeImportsAgents(claudePath: string): Promise<boolean> {
  const existing = await readFile(claudePath, "utf8").catch(() => "");
  if (!existing.trim()) {
    await writeFile(
      claudePath,
      ["# CLAUDE.md", "", "Ghost Invasion keeps canonical repo memory in AGENTS.md.", "", "@AGENTS.md", ""].join("\n"),
      "utf8"
    );
    return true;
  }
  if (/\bAGENTS\.md\b/.test(existing)) return true;
  await writeFile(claudePath, `${existing.trimEnd()}\n\n@AGENTS.md\n`, "utf8");
  return true;
}

function parseMemoryFacts(body: string): Record<string, string> {
  const betweenMarkers =
    body.includes(GHOST_MEMORY_START) && body.includes(GHOST_MEMORY_END)
      ? body.slice(body.indexOf(GHOST_MEMORY_START) + GHOST_MEMORY_START.length, body.indexOf(GHOST_MEMORY_END))
      : body;
  const facts: Record<string, string> = {};
  for (const line of betweenMarkers.split(/\r?\n/)) {
    const match = /^-\s*([a-z0-9_.-]+):\s*(.+)\s*$/i.exec(line.trim());
    if (match) facts[match[1]!] = match[2]!;
  }
  return facts;
}

function orderedFacts(facts: Record<string, string>): Array<[string, string]> {
  const known = FACT_ORDER.filter((key) => Object.hasOwn(facts, key)).map((key) => [key, facts[key]!] as [string, string]);
  const extra = Object.entries(facts)
    .filter(([key]) => !FACT_ORDER.includes(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return [...known, ...extra];
}

function sanitizeFactValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
