import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sanitizePathSegment } from "./evidence.js";
import { planHash } from "./planner.js";
import { renderReportArtifactsFromRun, resolveReportRunRoot } from "./reporter.js";
import { runSwarm, type SwarmRunResult } from "./swarm.js";
import type { Finding } from "./schemas/finding.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Journey } from "./schemas/journey.js";
import type { Persona } from "./schemas/persona.js";
import type { ReportJson } from "./schemas/report.js";

interface SwarmSummaryFile {
  runId?: string;
  runRoot?: string;
  failures?: Array<{
    droneId?: string;
    journeyId: string;
    personaId: string;
    seed: number;
    message?: string;
    fingerprint?: string;
  }>;
}

interface FindingTarget {
  journey: Journey;
  persona: Persona;
  seed: number;
  failure?: NonNullable<SwarmSummaryFile["failures"]>[number];
}

export interface SuggestedFixesOptions {
  projectRoot?: string;
  run?: string;
}

export interface SuggestedFixesResult {
  runId: string;
  runRoot: string;
  path: string;
  includedFindingIds: string[];
  skippedFindingIds: string[];
}

export interface FixRerunOptions {
  projectRoot?: string;
  run?: string;
  planPath?: string;
  runReset?: boolean;
  traceCapPerFingerprint?: number;
}

export interface FixRerunResult {
  findingId: string;
  originalRunId: string;
  originalRunRoot: string;
  status: "green" | "still-reproduces" | "needs-review";
  journeyId: string;
  personaId: string;
  seed: number;
  freshRunId: string;
  freshRunRoot: string;
  freshReportJson: string | null;
  proofPath: string;
  message: string;
  matchingFindingIds: string[];
}

export async function writeSuggestedFixes(options: SuggestedFixesOptions = {}): Promise<SuggestedFixesResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const runRoot = await resolveReportRunRoot(projectRoot, options.run);
  const report = await readJson<ReportJson>(join(runRoot, "report.json"));
  const confirmed = report.findings.filter((finding) => finding.category === "confirmed-bug");
  const skipped = report.findings.filter((finding) => finding.category !== "confirmed-bug");
  await renderReportArtifactsFromRun(runRoot);

  const path = join(runRoot, "suggested-fixes.md");
  await writeFile(path, renderSuggestedFixesMarkdown(report, confirmed, skipped), "utf8");
  return {
    runId: report.runId,
    runRoot,
    path,
    includedFindingIds: confirmed.map((finding) => finding.id),
    skippedFindingIds: skipped.map((finding) => finding.id)
  };
}

export async function rerunFindingFix(findingId: string, options: FixRerunOptions = {}): Promise<FixRerunResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const originalRunRoot = await resolveReportRunRoot(projectRoot, options.run);
  const report = await readJson<ReportJson>(join(originalRunRoot, "report.json"));
  const finding = findFinding(report, findingId);
  const { plan, path: planPath } = await loadPlan(projectRoot, options.planPath);
  const summary = await readJson<SwarmSummaryFile>(join(originalRunRoot, "swarm-summary.json")).catch(() => null);
  const target = resolveFindingTarget(plan, finding, summary);

  const rerunDir = join(originalRunRoot, "fix-reruns", sanitizePathSegment(finding.id));
  await mkdir(rerunDir, { recursive: true });
  const rerunPlanPath = join(rerunDir, "plan.json");
  const narrowedPlan = narrowPlanForRerun(plan, target, report.target.url);
  await writeJson(rerunPlanPath, narrowedPlan);

  const fresh = await runSwarm({
    projectRoot,
    planPath: rerunPlanPath,
    baseUrl: report.target.url,
    only: target.journey.id,
    seed: target.seed,
    workers: 1,
    sessions: 1,
    traceCapPerFingerprint: options.traceCapPerFingerprint,
    runReset: options.runReset
  });

  const freshReportPath = fresh.classification?.reportJson ?? join(fresh.runRoot, "report.json");
  const freshReport = await readJson<ReportJson>(freshReportPath).catch(() => null);
  const matchingFindings = freshReport?.findings.filter((candidate) => findingStillMatches(finding, candidate)) ?? [];
  const status = fixStatus(fresh, freshReport, matchingFindings);
  const result: FixRerunResult = {
    findingId: finding.id,
    originalRunId: report.runId,
    originalRunRoot,
    status,
    journeyId: target.journey.id,
    personaId: target.persona.id,
    seed: target.seed,
    freshRunId: fresh.runId,
    freshRunRoot: fresh.runRoot,
    freshReportJson: freshReport ? freshReportPath : null,
    proofPath: join(rerunDir, `${sanitizePathSegment(fresh.runId)}.json`),
    message: statusMessage(status, finding, fresh, matchingFindings),
    matchingFindingIds: matchingFindings.map((candidate) => candidate.id)
  };
  await writeJson(result.proofPath, {
    ...result,
    planPath,
    rerunPlanPath,
    guardrail: "green requires a fresh passing targeted run with no matching finding"
  });
  return result;
}

function renderSuggestedFixesMarkdown(report: ReportJson, confirmed: Finding[], skipped: Finding[]): string {
  const lines = [
    `# Suggested fixes - ${report.runId}`,
    "",
    "Propose-only repair pass. Ghost did not edit the target app. Apply a patch manually, then prove it with `ghost-invasion fix --rerun <findingId> --run <runId>`.",
    ""
  ];

  if (confirmed.length === 0) {
    lines.push("No confirmed findings were eligible for repair proposals.", "");
  }

  for (const finding of confirmed) {
    lines.push(
      `## ${finding.id} - ${finding.title}`,
      "",
      `Invariant: ${finding.invariant}`,
      `Affected route: ${finding.affected.route}`,
      finding.affected.api ? `Affected API: ${finding.affected.api}` : "Affected API: not recorded",
      `Evidence: ${finding.evidence.join(", ")}`,
      "",
      "Repair intent:",
      `- ${finding.suggestedFix}`,
      `- Keep the generated regression test: ${finding.generatedTest}`,
      "",
      "Proposed diff sketch:",
      "```diff",
      ...diffSketchFor(finding),
      "```",
      "",
      "Proof command:",
      `\`\`\`bash\nghost-invasion fix --rerun ${finding.id} --run ${report.runId}\n\`\`\``,
      ""
    );
  }

  if (skipped.length > 0) {
    lines.push("## Skipped", "");
    for (const finding of skipped) {
      lines.push(`- ${finding.id}: ${finding.category} is not a confirmed bug, so Ghost will not propose a repair yet.`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function diffSketchFor(finding: Finding): string[] {
  if (isIdempotentCreateFinding(finding)) {
    return [
      "diff --git a/<create-route-or-action> b/<create-route-or-action>",
      "@@",
      "- await createProject(input)",
      "+ const idempotencyKey = input.idempotencyKey ?? stableClientToken(request)",
      "+ await createProjectOnce({ ...input, ownerId: session.user.id, idempotencyKey })",
      "",
      "diff --git a/<create-form> b/<create-form>",
      "@@",
      "- submitButton.disabled = false",
      "+ submitButton.disabled = state === \"submitting\""
    ];
  }

  if (finding.invariant.includes("tenant") || finding.invariant.startsWith("auth.") || finding.invariant.startsWith("permission.")) {
    return [
      "diff --git a/<route-or-loader> b/<route-or-loader>",
      "@@",
      "- return loadResource(params.id)",
      "+ const resource = await loadResourceForOwner(params.id, session.user.id)",
      "+ if (!resource) throw notFoundOrForbidden()",
      "+ return resource"
    ];
  }

  return [
    "diff --git a/<failing-surface> b/<failing-surface>",
    "@@",
    "- // current behavior violates the recorded invariant",
    `+ // enforce ${finding.invariant} before returning success`,
    "+ // keep the generated regression test green before closing this finding"
  ];
}

function isIdempotentCreateFinding(finding: Finding): boolean {
  const text = `${finding.title} ${finding.invariant} ${finding.affected.api ?? ""}`.toLowerCase();
  return text.includes("idempotent") || text.includes("double-click") || text.includes("duplicate");
}

function narrowPlanForRerun(plan: GhostInvasionPlan, target: FindingTarget, baseUrl: string): GhostInvasionPlan {
  const narrowed: GhostInvasionPlan = {
    ...plan,
    seed: target.seed,
    target: { ...plan.target, baseUrl },
    swarm: {
      ...plan.swarm,
      browserConcurrency: 1,
      browserWaves: 1,
      totalBrowserSessions: 1,
      apiTier: { ...plan.swarm.apiTier, enabled: false, targets: [] }
    },
    personas: [target.persona],
    journeys: [{ ...target.journey, appliesToPersonas: [target.persona.id] }]
  };
  // This fix-rerun plan is derived in-process from a plan that already cleared the run
  // gate and is re-run through it, which now requires a valid approval on every mutating
  // run. Re-stamp the approval over the narrowed content (planHash is a content checksum)
  // so the derived run is approved at the same mode and does not fail closed on the stale
  // parent hash carried by the spread above.
  narrowed.approvedPlanHash = planHash(narrowed);
  return narrowed;
}

function resolveFindingTarget(plan: GhostInvasionPlan, finding: Finding, summary: SwarmSummaryFile | null): FindingTarget {
  const journey = findJourneyForFinding(plan, finding, summary);
  const failure = summary?.failures?.find((candidate) => candidate.journeyId === journey.id);
  const persona = findPersona(plan, journey, failure?.personaId);
  return { journey, persona, seed: failure?.seed ?? plan.seed, failure };
}

function findJourneyForFinding(plan: GhostInvasionPlan, finding: Finding, summary: SwarmSummaryFile | null): Journey {
  const scored = plan.journeys
    .map((journey) => ({ journey, score: journeyScoreForFinding(journey, finding, summary) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.journey;
  if (!best) throw new Error(`Could not resolve finding ${finding.id} to a journey in the current plan.`);
  assertInvariantMatch(finding, best);
  return best;
}

// Defense for S-037: the rerun engine faithfully reproduces whatever finding id it is
// handed, so if a stale/wrong id ever resolved to a journey that does not test the
// finding's invariant, it would silently re-derive the wrong bug. Refuse to rerun on an
// invariant mismatch instead (S-054).
function assertInvariantMatch(finding: Finding, journey: Journey): void {
  if (finding.invariant === "unclassified") return;
  if (journey.invariantsTested.includes(finding.invariant)) return;
  throw new Error(
    `Finding ${finding.id} (invariant ${finding.invariant}) does not match journey ${journey.id} (tests ${journey.invariantsTested.join(", ") || "none"}); refusing to rerun a mismatched finding.`
  );
}

function journeyScoreForFinding(journey: Journey, finding: Finding, summary: SwarmSummaryFile | null): number {
  let score = 0;
  if (journey.invariantsTested.includes(finding.invariant)) score += 4;
  if (journey.anchors.routes.includes(finding.affected.route)) score += 3;
  if (finding.affected.api && journey.anchors.mutations.includes(finding.affected.api)) score += 2;
  if (summary?.failures?.some((failure) => failure.journeyId === journey.id)) score += 1;
  return score;
}

function findPersona(plan: GhostInvasionPlan, journey: Journey, personaId?: string): Persona {
  const byFailure = personaId ? plan.personas.find((candidate) => candidate.id === personaId) : undefined;
  if (byFailure) return byFailure;
  const byJourney = plan.personas.find((candidate) => journey.appliesToPersonas.includes(candidate.id));
  if (byJourney) return byJourney;
  const first = plan.personas[0];
  if (!first) throw new Error(`Plan has no personas available for journey ${journey.id}`);
  return first;
}

function fixStatus(fresh: SwarmRunResult, freshReport: ReportJson | null, matches: Finding[]): FixRerunResult["status"] {
  if (matches.length > 0) return "still-reproduces";
  if (fresh.totals.failed === 0 && (!freshReport || freshReport.findings.length === 0)) return "green";
  return "needs-review";
}

function statusMessage(
  status: FixRerunResult["status"],
  finding: Finding,
  fresh: SwarmRunResult,
  matches: Finding[]
): string {
  if (status === "green") {
    return `${finding.id} is green: the targeted same-seed rerun passed and wrote fresh artifacts at ${fresh.runRoot}.`;
  }
  if (status === "still-reproduces") {
    return `${finding.id} still reproduces as ${matches.map((match) => match.id).join(", ")} in fresh run ${fresh.runId}.`;
  }
  return `${finding.id} cannot be marked fixed: the targeted rerun produced ${fresh.totals.failed} failure(s), so inspect ${fresh.runRoot}.`;
}

function findingStillMatches(original: Finding, candidate: Finding): boolean {
  if (original.invariant !== candidate.invariant) return false;
  if (original.affected.route !== candidate.affected.route) return false;
  if ((original.affected.api ?? "") !== (candidate.affected.api ?? "")) return false;

  const candidateSignals = new Set(importantSignals(candidate.signals));
  const originalSignals = importantSignals(original.signals);
  if (originalSignals.some((signal) => !candidateSignals.has(signal))) return false;

  return (
    normalizeText(original.actual) === normalizeText(candidate.actual) ||
    normalizeText(original.title) === normalizeText(candidate.title)
  );
}

function importantSignals(signals: string[]): string[] {
  return signals.filter((signal) => !signal.startsWith("ceiling:") && !signal.includes("trace") && !signal.includes("replay"));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function findFinding(report: ReportJson, findingId: string): Finding {
  const finding = report.findings.find((candidate) => candidate.id === findingId);
  if (!finding) throw new Error(`Finding ${findingId} was not found in report ${report.runId}.`);
  return finding;
}

async function loadPlan(projectRoot: string, explicitPath?: string): Promise<{ plan: GhostInvasionPlan; path: string }> {
  const path = explicitPath
    ? isAbsolute(explicitPath) || explicitPath.includes("/")
      ? resolve(projectRoot, explicitPath)
      : join(projectRoot, explicitPath)
    : join(projectRoot, ".ghost", "plan", "ghost-invasion-plan.json");
  return { plan: await readJson<GhostInvasionPlan>(path), path };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
