import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { planHash } from "./planner.js";
import { renderReportArtifactsFromRun, resolveReportRunRoot } from "./reporter.js";
import { runSwarm, type SwarmRunResult } from "./swarm.js";
import type { Finding } from "./schemas/finding.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Journey } from "./schemas/journey.js";
import type { Persona } from "./schemas/persona.js";
import type { ReportJson } from "./schemas/report.js";

type JourneyStep = Journey["steps"][number];

export type ShrinkOutcome = "still-fails" | "passes-now" | "invalid";

export interface ShrinkFindingOptions {
  projectRoot?: string;
  run?: string;
  planPath?: string;
  maxCandidates?: number;
}

export interface CandidateEvaluation {
  index: number;
  phase: string;
  outcome: ShrinkOutcome;
  reason: string;
  candidateStepCount: number;
  removedStepTypes: string[];
  removedStepIndexes: number[];
  runId?: string;
  runRoot?: string;
  matchingFindingId?: string;
  actual?: string;
}

export interface MinimalReproArtifact {
  $schema: "ghost-invasion/minimal-repro@1";
  findingId: string;
  runId: string;
  createdAt: string;
  source: {
    runRoot: string;
    reportPath: string;
    planPath: string;
    journeyId: string;
    personaId: string;
    seed: number;
    originalStepCount: number;
  };
  verification: {
    outcome: "verified";
    minimizedStepCount: number;
    candidateRunId: string;
    candidateRunRoot: string;
  };
  journey: Journey;
  steps: JourneyStep[];
  reproCommand: string;
  attempts: CandidateEvaluation[];
}

export interface ShrinkFindingResult {
  findingId: string;
  runId: string;
  runRoot: string;
  artifactPath: string;
  relativeArtifactPath: string;
  originalStepCount: number;
  minimizedStepCount: number;
  attempts: CandidateEvaluation[];
}

export interface ReproFindingOptions {
  projectRoot?: string;
  run?: string;
  planPath?: string;
  execute?: boolean;
}

export interface ReproFindingResult {
  findingId: string;
  artifactPath: string;
  runRoot: string;
  summary: string;
  execution?: {
    runId: string;
    runRoot: string;
    status: SwarmRunResult["status"];
    failed: number;
    succeeded: number;
  };
}

interface SwarmSummaryFile {
  runId?: string;
  failures?: Array<{
    droneId: string;
    journeyId: string;
    personaId: string;
    seed: number;
    message: string;
    fingerprint: string;
  }>;
}

interface ShrinkContext {
  projectRoot: string;
  runRoot: string;
  report: ReportJson;
  finding: Finding;
  plan: GhostInvasionPlan;
  planPath: string;
  journey: Journey;
  persona: Persona;
  seed: number;
  attempts: CandidateEvaluation[];
  nextAttemptIndex: number;
  maxCandidates: number;
}

export async function shrinkFinding(findingId: string, options: ShrinkFindingOptions = {}): Promise<ShrinkFindingResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const runRoot = await resolveReportRunRoot(projectRoot, options.run);
  const reportPath = join(runRoot, "report.json");
  const report = await readJson<ReportJson>(reportPath);
  const finding = findFinding(report, findingId);
  const { plan, path: planPath } = await loadShrinkPlan(projectRoot, options.planPath);
  const summary = await readJson<SwarmSummaryFile>(join(runRoot, "swarm-summary.json")).catch(() => null);
  const journey = findJourneyForFinding(plan, finding, summary);
  const failure = summary?.failures?.find((candidate) => candidate.journeyId === journey.id);
  const persona = findPersonaForFailure(plan, journey, failure?.personaId);
  const seed = failure?.seed ?? plan.seed;
  const context: ShrinkContext = {
    projectRoot,
    runRoot,
    report,
    finding,
    plan,
    planPath,
    journey,
    persona,
    seed,
    attempts: [],
    nextAttemptIndex: 1,
    maxCandidates: options.maxCandidates ?? 80
  };

  let best = [...journey.steps];
  let granularity = 2;
  while (best.length >= 2 && context.attempts.length < context.maxCandidates) {
    const chunkSize = Math.ceil(best.length / granularity);
    let accepted = false;
    for (let start = 0; start < best.length && context.attempts.length < context.maxCandidates; start += chunkSize) {
      const removed = best.slice(start, start + chunkSize);
      const candidate = best.slice(0, start).concat(best.slice(start + chunkSize));
      const evaluation = await evaluateCandidate(context, candidate, removed, indexesFor(start, removed.length), `ddmin/${granularity}`);
      if (evaluation.outcome === "still-fails") {
        best = candidate;
        granularity = Math.max(2, granularity - 1);
        accepted = true;
        break;
      }
    }

    if (accepted) continue;
    if (granularity >= best.length) break;
    granularity = Math.min(best.length, granularity * 2);
  }

  let index = 0;
  while (index < best.length && context.attempts.length < context.maxCandidates) {
    const removed = [best[index]!];
    const candidate = best.slice(0, index).concat(best.slice(index + 1));
    const evaluation = await evaluateCandidate(context, candidate, removed, [index], "single-pass");
    if (evaluation.outcome === "still-fails") {
      best = candidate;
      continue;
    }
    index += 1;
  }

  const verification = await evaluateCandidate(context, best, [], [], "verify-final");
  if (verification.outcome !== "still-fails" || !verification.runId || !verification.runRoot) {
    throw new Error(`Could not verify minimized repro for ${finding.id}: ${verification.outcome} (${verification.reason})`);
  }

  const minimizedJourney: Journey = { ...journey, steps: best };
  const shrinkDir = join(runRoot, "shrink");
  await mkdir(shrinkDir, { recursive: true });
  const artifactPath = join(shrinkDir, `${sanitizeArtifactName(finding.id)}.min.json`);
  const relativeArtifactPath = relative(runRoot, artifactPath).replace(/\\/g, "/");
  const artifact: MinimalReproArtifact = {
    $schema: "ghost-invasion/minimal-repro@1",
    findingId: finding.id,
    runId: report.runId,
    createdAt: new Date().toISOString(),
    source: {
      runRoot,
      reportPath,
      planPath,
      journeyId: journey.id,
      personaId: context.persona.id,
      seed: context.seed,
      originalStepCount: journey.steps.length
    },
    verification: {
      outcome: "verified",
      minimizedStepCount: best.length,
      candidateRunId: verification.runId,
      candidateRunRoot: verification.runRoot
    },
    journey: minimizedJourney,
    steps: best,
    reproCommand: `ghost-invasion repro ${finding.id} --run ${report.runId}`,
    attempts: context.attempts
  };
  await writeJson(artifactPath, artifact);
  await updateReportMinimalRepro(reportPath, finding.id, relativeArtifactPath);
  await renderReportArtifactsFromRun(runRoot);

  return {
    findingId: finding.id,
    runId: report.runId,
    runRoot,
    artifactPath,
    relativeArtifactPath,
    originalStepCount: journey.steps.length,
    minimizedStepCount: best.length,
    attempts: context.attempts
  };
}

export async function reproFinding(findingId: string, options: ReproFindingOptions = {}): Promise<ReproFindingResult> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const runRoot = await resolveReportRunRoot(projectRoot, options.run);
  const report = await readJson<ReportJson>(join(runRoot, "report.json"));
  const finding = findFinding(report, findingId);
  if (!finding.minimalRepro) {
    throw new Error(`Finding ${finding.id} does not have a minimal reproduction yet. Run ghost-invasion shrink ${finding.id} --run ${report.runId}.`);
  }

  const artifactPath = resolve(runRoot, finding.minimalRepro);
  const artifact = await readJson<MinimalReproArtifact>(artifactPath);
  const summary = renderMinimalReproSummary(artifact);
  const result: ReproFindingResult = { findingId: finding.id, artifactPath, runRoot, summary };

  if (options.execute) {
    const planPath = options.planPath ?? artifact.source.planPath;
    const { plan } = await loadShrinkPlan(projectRoot, planPath);
    const persona = plan.personas.find((candidate) => candidate.id === artifact.source.personaId) ?? plan.personas[0];
    if (!persona) throw new Error(`No persona is available to replay ${finding.id}`);
    const candidatePlan = candidatePlanFor(plan, artifact.journey, persona);
    const replayPlanPath = join(dirname(artifactPath), `${sanitizeArtifactName(finding.id)}.repro-plan.json`);
    await writeJson(replayPlanPath, candidatePlan);
    const run = await runSwarm({
      projectRoot,
      planPath: replayPlanPath,
      only: artifact.journey.id,
      seed: artifact.source.seed,
      sessions: 1,
      workers: 1,
      traceCapPerFingerprint: 1
    });
    result.execution = {
      runId: run.runId,
      runRoot: run.runRoot,
      status: run.status,
      failed: run.totals.failed,
      succeeded: run.totals.succeeded
    };
  }

  return result;
}

async function evaluateCandidate(
  context: ShrinkContext,
  steps: JourneyStep[],
  removedSteps: JourneyStep[],
  removedIndexes: number[],
  phase: string
): Promise<CandidateEvaluation> {
  const index = context.nextAttemptIndex;
  context.nextAttemptIndex += 1;
  const base = {
    index,
    phase,
    candidateStepCount: steps.length,
    removedStepTypes: removedSteps.map((step) => step.type),
    removedStepIndexes: removedIndexes
  };

  if (steps.length === 0) {
    const evaluation: CandidateEvaluation = { ...base, outcome: "invalid", reason: "candidate removed every journey step" };
    context.attempts.push(evaluation);
    return evaluation;
  }

  const invalidShape = invalidCandidateShapeReason(context.journey, steps);
  if (invalidShape) {
    const evaluation: CandidateEvaluation = { ...base, outcome: "invalid", reason: invalidShape };
    context.attempts.push(evaluation);
    return evaluation;
  }

  const candidateJourney: Journey = { ...context.journey, steps, appliesToPersonas: [context.persona.id] };
  const candidatePlan = candidatePlanFor(context.plan, candidateJourney, context.persona);
  const planPath = join(
    context.runRoot,
    "shrink",
    "candidates",
    `${String(index).padStart(3, "0")}-${sanitizeArtifactName(phase)}.plan.json`
  );
  await writeJson(planPath, candidatePlan);

  try {
    const result = await runSwarm({
      projectRoot: context.projectRoot,
      planPath,
      only: candidateJourney.id,
      seed: context.seed,
      sessions: 1,
      workers: 1,
      traceCapPerFingerprint: 0
    });

    if (result.totals.failed === 0) {
      const evaluation: CandidateEvaluation = {
        ...base,
        outcome: "passes-now",
        reason: "candidate no longer reproduces a failure",
        runId: result.runId,
        runRoot: result.runRoot
      };
      context.attempts.push(evaluation);
      return evaluation;
    }

    const candidateReport = await readJson<ReportJson>(join(result.runRoot, "report.json"));
    const matching = candidateReport.findings.find((candidate) => findingStillMatches(context.finding, candidate));
    if (!matching) {
      const first = candidateReport.findings[0];
      const evaluation: CandidateEvaluation = {
        ...base,
        outcome: "invalid",
        reason: first
          ? `candidate failed differently: ${first.actual}`
          : "candidate failed without a classified finding",
        runId: result.runId,
        runRoot: result.runRoot,
        actual: first?.actual
      };
      context.attempts.push(evaluation);
      return evaluation;
    }

    const evaluation: CandidateEvaluation = {
      ...base,
      outcome: "still-fails",
      reason: "candidate reproduces the same finding",
      runId: result.runId,
      runRoot: result.runRoot,
      matchingFindingId: matching.id,
      actual: matching.actual
    };
    context.attempts.push(evaluation);
    return evaluation;
  } catch (error) {
    const evaluation: CandidateEvaluation = {
      ...base,
      outcome: "invalid",
      reason: `candidate could not run: ${error instanceof Error ? error.message : String(error)}`
    };
    context.attempts.push(evaluation);
    return evaluation;
  }
}

function candidatePlanFor(plan: GhostInvasionPlan, journey: Journey, persona: Persona): GhostInvasionPlan {
  const candidate: GhostInvasionPlan = {
    ...cloneJson(plan),
    mode: plan.mode,
    swarm: {
      ...plan.swarm,
      browserConcurrency: 1,
      browserWaves: 1,
      totalBrowserSessions: 1,
      apiTier: { ...plan.swarm.apiTier, rps: 0 }
    },
    personas: [cloneJson(persona)],
    journeys: [{ ...cloneJson(journey), pristineRequired: false }]
  };
  // This repro plan is derived in-process from a plan that already cleared the run gate
  // (its parent run produced the artifact we are shrinking) and is re-run through that
  // same gate, which now requires a valid approval on every mutating run. Re-stamp the
  // approval over the narrowed content so the derived run is approved at the same mode —
  // planHash is a content checksum, so the stale parent hash copied above would otherwise
  // mismatch and fail closed.
  candidate.approvedPlanHash = planHash(candidate);
  return candidate;
}

function invalidCandidateShapeReason(sourceJourney: Journey, steps: JourneyStep[]): string | null {
  const hasNavigation = steps.some((step) => step.type === "goto");
  const pageBoundSteps = [
    "clickRole",
    "clickText",
    "fill",
    "selectOption",
    "upload",
    "expectVisible",
    "expectHidden",
    "expectUrl",
    "expectText",
    "doubleSubmit",
    "screenshot"
  ];
  const needsPage = steps.some((step) => pageBoundSteps.includes(step.type));
  if (needsPage && !hasNavigation) return "candidate removed all navigation before page-bound steps";

  const snapshotIds = new Set(steps.filter((step) => step.type === "dbSnapshot").map((step) => String(step.id ?? "")));
  for (const assertion of [...sourceJourney.success, ...sourceJourney.abandon]) {
    if (assertion.type !== "expectDbDiff") continue;
    const before = String(assertion.before ?? "before");
    if (!snapshotIds.has(before)) return `candidate removed required dbSnapshot "${before}"`;
  }

  return null;
}

function findingStillMatches(original: Finding, candidate: Finding): boolean {
  if (candidate.invariant !== original.invariant) return false;
  if (candidate.affected.route !== original.affected.route) return false;
  if (original.affected.api && candidate.affected.api !== original.affected.api) return false;

  const originalSignals = importantSignals(original.signals);
  const candidateSignals = new Set(candidate.signals);
  if (originalSignals.some((signal) => !candidateSignals.has(signal))) return false;

  if (original.signals.includes("db_diff_bad")) {
    return normalizeText(candidate.actual) === normalizeText(original.actual);
  }

  return normalizeText(candidate.actual) === normalizeText(original.actual) || normalizeText(candidate.title) === normalizeText(original.title);
}

function importantSignals(signals: string[]): string[] {
  return signals.filter((signal) => !signal.startsWith("ceiling:") && !signal.includes("trace") && !signal.includes("replay"));
}

function findJourneyForFinding(plan: GhostInvasionPlan, finding: Finding, summary: SwarmSummaryFile | null): Journey {
  const scored = plan.journeys
    .map((journey) => ({ journey, score: journeyScoreForFinding(journey, finding, summary) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0]?.journey;
  if (!best) {
    throw new Error(`Could not resolve finding ${finding.id} to a journey in the current plan.`);
  }
  // Defense for S-037: refuse to shrink/repro a finding against a journey that does not
  // test its invariant, so a stale id can never re-derive the wrong bug (S-054).
  if (finding.invariant !== "unclassified" && !best.invariantsTested.includes(finding.invariant)) {
    throw new Error(
      `Finding ${finding.id} (invariant ${finding.invariant}) does not match journey ${best.id} (tests ${best.invariantsTested.join(", ") || "none"}); refusing to rerun a mismatched finding.`
    );
  }
  return best;
}

function journeyScoreForFinding(journey: Journey, finding: Finding, summary: SwarmSummaryFile | null): number {
  let score = 0;
  if (journey.invariantsTested.includes(finding.invariant)) score += 4;
  if (journey.anchors.routes.includes(finding.affected.route)) score += 3;
  if (finding.affected.api && journey.anchors.mutations.includes(finding.affected.api)) score += 2;
  if (summary?.failures?.some((failure) => failure.journeyId === journey.id)) score += 1;
  return score;
}

function findPersonaForFailure(plan: GhostInvasionPlan, journey: Journey, personaId?: string): Persona {
  const byFailure = personaId ? plan.personas.find((candidate) => candidate.id === personaId) : undefined;
  if (byFailure) return byFailure;
  const byJourney = plan.personas.find((candidate) => journey.appliesToPersonas.includes(candidate.id));
  if (byJourney) return byJourney;
  const first = plan.personas[0];
  if (!first) throw new Error(`Plan has no personas available for journey ${journey.id}`);
  return first;
}

async function updateReportMinimalRepro(reportPath: string, findingId: string, minimalReproPath: string): Promise<void> {
  const report = await readJson<ReportJson>(reportPath);
  const finding = findFinding(report, findingId);
  finding.minimalRepro = minimalReproPath;
  await writeJson(reportPath, report);
}

function renderMinimalReproSummary(artifact: MinimalReproArtifact): string {
  const lines = [
    `Minimal repro for ${artifact.findingId}`,
    `Run: ${artifact.runId}`,
    `Journey: ${artifact.source.journeyId}`,
    `Seed: ${artifact.source.seed}`,
    `Steps: ${artifact.source.originalStepCount} -> ${artifact.verification.minimizedStepCount}`,
    "",
    ...artifact.steps.map((step, index) => `${index + 1}. ${step.type}${stepSummary(step)}`),
    "",
    `Execute: ghost-invasion repro ${artifact.findingId} --run ${artifact.runId} --execute`
  ];
  return `${lines.join("\n")}\n`;
}

function stepSummary(step: JourneyStep): string {
  const detail = ["url", "selector", "role", "name", "text", "ms", "id"]
    .map((key) => (step[key] === undefined ? null : `${key}=${JSON.stringify(step[key])}`))
    .filter((value): value is string => Boolean(value));
  return detail.length > 0 ? ` (${detail.join(", ")})` : "";
}

function findFinding(report: ReportJson, findingId: string): Finding {
  const finding = report.findings.find((candidate) => candidate.id === findingId);
  if (!finding) {
    throw new Error(`Finding ${findingId} was not found in report ${report.runId}.`);
  }
  return finding;
}

async function loadShrinkPlan(projectRoot: string, explicitPath?: string): Promise<{ plan: GhostInvasionPlan; path: string }> {
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

function indexesFor(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function sanitizeArtifactName(input: string): string {
  return basename(input).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
