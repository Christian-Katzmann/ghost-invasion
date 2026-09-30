import { readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  classForInvariantId,
  evidenceRequiredForInvariant,
  loadInvariantLedger,
  loadRiskPack,
  severityForInvariant,
  type RiskPack
} from "./contracts.js";
import type { CostReport } from "./cost-model.js";
import { failureFingerprint, sanitizePathSegment, type EvidenceEvent } from "./evidence.js";
import { isPaymentJourney, stripeLocalstripeService } from "./run-modes.js";
import type { Finding } from "./schemas/finding.js";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Journey } from "./schemas/journey.js";
import type { Persona } from "./schemas/persona.js";
import { deriveRunStatus, type ReportJson } from "./schemas/report.js";

export interface PristineSentinelResult {
  journeyId: string;
  ok: boolean;
  droneId: string;
  message?: string;
}

export interface SwarmSummaryForClassifier {
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
  reproductionBudget?: Record<string, { attempts: number; reproduced: number; otherFailures: number }>;
  failures?: Array<{
    droneId: string;
    journeyId: string;
    personaId: string;
    seed: number;
    message: string;
    fingerprint: string;
  }>;
  // Carries the evidence-spine degraded flag so a run with an incomplete proof log
  // forces an unclean run status (F4, R1).
  evidence?: { degraded?: boolean };
}

export interface ConfidenceCeilingInput {
  category: Finding["category"];
  confidence: number;
  pristinePassed: boolean;
  mockDependent: boolean;
  invariantClass: "hard" | "soft" | "unknown";
  evidenceKinds: string[];
  claimKind: "state-change" | "tenant-permission" | "ux-trap" | "runtime-error" | "performance" | "unknown";
  proofComplete: boolean;
}

export interface ConfidenceCeilingResult {
  category: Finding["category"];
  confidence: number;
  reasons: string[];
}

interface DbDiffArtifact {
  table?: string;
  expectedInserted?: number;
  actualInserted?: number;
  pass?: boolean;
}

interface FailureSeed {
  droneId: string;
  journeyId: string;
  personaId: string;
  seed: number;
  message: string;
  fingerprint: string;
}

interface StepErrorEvent extends EvidenceEvent {
  droneId: string;
  primitive?: string;
  message?: string;
}

interface EvidenceArtifacts {
  evidence: string[];
  kinds: Set<string>;
  dbDiff: DbDiffArtifact | null;
}

interface ClusterDraft {
  fingerprint: string;
  finding: Finding;
  summary: Record<string, unknown>;
}

const severityRank: Record<Finding["severity"], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1
};

export function applyConfidenceCeilings(input: ConfidenceCeilingInput): ConfidenceCeilingResult {
  let category = input.category;
  let confidence = Math.max(0, Math.min(1, input.confidence));
  const reasons: string[] = [];
  const evidenceKinds = new Set(input.evidenceKinds);
  const hasDbDiff = evidenceKinds.has("db_diff");
  const hasReplay = evidenceKinds.has("trace") || evidenceKinds.has("video") || evidenceKinds.has("replay");

  if (input.claimKind === "state-change" && !hasDbDiff) {
    confidence = Math.min(confidence, 0.75);
    if (category === "confirmed-bug") category = "suspicious";
    reasons.push("no-db-diff-state-change");
  }

  if (!input.pristinePassed) {
    confidence = Math.min(confidence, 0.6);
    if (category === "confirmed-bug") category = "needs-human-review";
    reasons.push("pristine-failed");
  }

  if (input.mockDependent) {
    confidence = Math.min(confidence, 0.8);
    reasons.push("mock-dependent");
  }

  if (!hasReplay) {
    confidence = Math.min(confidence, 0.65);
    if (category === "confirmed-bug") category = "suspicious";
    reasons.push("missing-trace-replay");
  }

  if (input.invariantClass === "soft") {
    confidence = Math.min(confidence, 0.7);
    if (category === "confirmed-bug") category = "needs-human-review";
    reasons.push("soft-invariant");
  }

  if (!input.proofComplete) {
    confidence = Math.min(confidence, 0.7);
    if (category === "confirmed-bug") category = hasReplay ? "needs-human-review" : "suspicious";
    reasons.push("missing-category-proof");
  }

  return { category, confidence: roundConfidence(confidence), reasons };
}

export async function classifyRun(options: {
  projectRoot: string;
  plan: GhostInvasionPlan;
  swarmSummary: SwarmSummaryForClassifier;
  pristineResults?: PristineSentinelResult[];
  tokenBudget?: number;
  cost: CostReport;
}): Promise<{ report: ReportJson; reportPath: string; summaryPath: string }> {
  const runRoot = options.swarmSummary.runRoot;
  const events = await readJsonl(join(runRoot, "events.jsonl"));
  const stepErrors = latestStepErrors(events);
  const failures = failureSeeds(options.swarmSummary, events, stepErrors);
  const pristine = pristineByJourney(options.pristineResults ?? pristineResultsFromEvents(events));
  const ledger = await loadInvariantLedger(options.projectRoot);
  const pack: RiskPack | null = await loadRiskPack(options.plan.pack, { projectRoot: options.projectRoot }).catch(() => null);
  const clusters = new Map<string, FailureSeed[]>();

  for (const failure of failures) {
    const group = clusters.get(failure.fingerprint) ?? [];
    group.push(failure);
    clusters.set(failure.fingerprint, group);
  }

  const drafts: ClusterDraft[] = [];

  for (const [fingerprint, group] of clusters) {
    const first = group[0]!;
    const journey = options.plan.journeys.find((candidate) => candidate.id === first.journeyId);
    if (!journey) continue;
    const artifacts = await artifactsForGroup(runRoot, group);
    const invariant = journey.invariantsTested[0] ?? "unclassified";
    const invariantClass = classForInvariantId(ledger, invariant);
    const claimKind = claimKindFor(invariant, artifacts.kinds);
    const requiredEvidence = evidenceRequiredForInvariant(ledger, invariant, pack);
    const proofComplete = proofCompleteFor(claimKind, artifacts.kinds, requiredEvidence);
    const pristinePassed = journey.pristineRequired ? pristine.get(journey.id) === true : true;
    const mockDependent = isPaymentJourney(journey) && options.plan.safety.mocksApplied.includes(stripeLocalstripeService);
    const base = baseFindingFor({
      id: "",
      journey,
      fingerprint,
      group,
      artifacts,
      invariant,
      pristinePassed,
      mockDependent,
      plan: options.plan,
      reproductionBudget: options.swarmSummary.reproductionBudget?.[fingerprint]
    });
    const ceiling = applyConfidenceCeilings({
      category: base.category,
      confidence: base.confidence,
      pristinePassed,
      mockDependent,
      invariantClass,
      evidenceKinds: [...artifacts.kinds],
      claimKind,
      proofComplete
    });

    const finding: Finding = {
      ...base,
      severity: severityForInvariant(ledger, invariant, pack) ?? base.severity,
      category: ceiling.category,
      confidence: ceiling.confidence,
      signals: [...new Set([...base.signals, ...ceiling.reasons.map((reason) => `ceiling:${reason}`)])]
    };
    drafts.push({
      fingerprint,
      finding,
      summary: {
        fingerprint,
        journeyId: journey.id,
        occurrences: group.length,
        pristinePassed,
        evidenceKinds: [...artifacts.kinds].sort(),
        requiredEvidence,
        ceilingReasons: ceiling.reasons
      }
    });
  }

  // Finding ids must be stable for a given seed regardless of how many drones ran
  // concurrently or in what order they completed. Mint them in a deterministic order
  // (report priority, then the content fingerprint as a stable tiebreak) so `F-001`
  // always maps to the same finding across same-seed reruns at any concurrency (S-037).
  drafts.sort((a, b) => {
    const ranked = compareFindings(a.finding, b.finding);
    if (ranked !== 0) return ranked;
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  });

  const findings: Finding[] = [];
  const clusterSummaries: Array<Record<string, unknown>> = [];
  drafts.forEach((draft, position) => {
    const id = findingId(position + 1);
    const finding = enforceEvidenceGuardrail({
      ...draft.finding,
      id,
      reproSteps: `reproduction-steps/${id}.md`,
      generatedTest: `generated-tests/${id}.spec.ts`
    });
    findings.push(finding);
    clusterSummaries.push({ ...draft.summary, category: finding.category, confidence: finding.confidence });
  });

  findings.sort(compareFindings);
  const report: ReportJson = {
    $schema: "ghost-invasion/report@1",
    schemaVersion: "1.0",
    runId: options.swarmSummary.runId,
    target: {
      url: options.swarmSummary.target,
      stack: options.plan.target.stack,
      allowProductionTarget: options.plan.safety.targetRisk !== "local"
    },
    invasion: {
      personas: options.plan.personas.length,
      journeys: options.plan.journeys.length,
      pack: options.plan.pack,
      browserSessions: options.swarmSummary.scale.browserSessions,
      apiRequests: options.swarmSummary.scale.apiRequests,
      apiEndpointsHit: options.swarmSummary.scale.apiEndpointsHit,
      mode: options.plan.mode
    },
    scale: {
      headline: `${options.swarmSummary.scale.browserSessions} browser users in ${plural(options.swarmSummary.scale.browserWaves, "wave", "waves")} + ${options.swarmSummary.scale.apiRequests} API hits across ${plural(options.swarmSummary.scale.apiEndpointsHit, "endpoint", "endpoints")}`
    },
    runStatus: deriveRunStatus({
      state: options.swarmSummary.status,
      egressProven: options.plan.safety.egress.proven,
      quarantined: [...pristine.values()].some((ok) => ok === false),
      degraded: options.swarmSummary.evidence?.degraded ?? false
    }),
    totals: {
      findings: findings.length,
      critical: findings.filter((finding) => finding.severity === "critical").length,
      confirmedBugs: findings.filter((finding) => finding.category === "confirmed-bug").length,
      needsHumanReview: findings.filter((finding) => finding.category === "needs-human-review").length,
      falsePositivesSuppressed: findings.filter((finding) => finding.category !== "confirmed-bug").length
    },
    cost: options.cost,
    findings,
    safety: {
      mockedServices: options.plan.safety.mocksApplied,
      dataResetStrategy: options.plan.safety.dataReset.strategy,
      egress: { mode: options.plan.safety.egress.mode, proven: options.plan.safety.egress.proven },
      dangerousEnvKeysDetected: options.plan.safety.liveSecrets.map((secret) => secret.key)
    }
  };

  const classifierSummary = {
    schemaVersion: "1.0",
    phase: "one-pass-bounded-classifier",
    tokenBudget: options.tokenBudget ?? 8_000,
    mode: "deterministic-fallback",
    note: "Clusters are pre-aggregated deterministically; no model labels were needed for this bounded pass.",
    pristineSentinels: [...pristine.entries()].map(([journeyId, ok]) => ({ journeyId, ok })),
    clusters: clusterSummaries
  };
  const reportPath = join(runRoot, "report.json");
  const summaryPath = join(runRoot, "classifier-summary.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${JSON.stringify(classifierSummary, null, 2)}\n`, "utf8");
  return { report, reportPath, summaryPath };
}

function baseFindingFor(input: {
  id: string;
  journey: Journey;
  fingerprint: string;
  group: FailureSeed[];
  artifacts: EvidenceArtifacts;
  invariant: string;
  pristinePassed: boolean;
  mockDependent: boolean;
  plan: GhostInvasionPlan;
  reproductionBudget?: { attempts: number; reproduced: number; otherFailures: number };
}): Finding {
  const personas = new Set(input.group.map((failure) => failure.personaId));
  const seeds = new Set(input.group.map((failure) => failure.seed));
  const inputProfiles = new Set(
    input.group.map((failure) => personaById(input.plan, failure.personaId)?.dataState.inputProfile ?? "unknown")
  );
  const route = input.journey.anchors.routes[0] ?? "/";
  const mutation = input.journey.anchors.mutations[0];
  const expectedInserted = input.artifacts.dbDiff?.expectedInserted;
  const actualInserted = input.artifacts.dbDiff?.actualInserted;
  const isDuplicateMutation = input.invariant.includes("idempotent") || input.artifacts.kinds.has("db_diff");
  const isTenantLeak = input.invariant.includes("tenant") || input.invariant.startsWith("auth.") || input.invariant.startsWith("permission.");
  // The headline a human reads must be bound to what the artifact literally shows, not
  // inferred from a heuristic (S-015). Only assert the specific cross-tenant-read story
  // when an owner-check artifact proves it, and the duplicate-create story when the db
  // diff proves an extra row for an idempotency invariant. Otherwise fall back to the
  // observed failure message and a neutral, evidence-faithful narrative.
  const tenantLeakProven = isTenantLeak && input.artifacts.kinds.has("db_owner_check");
  const duplicateProven =
    input.invariant.includes("idempotent") &&
    typeof expectedInserted === "number" &&
    typeof actualInserted === "number" &&
    actualInserted > expectedInserted;
  const isFlaky = Boolean(
    input.reproductionBudget && input.reproductionBudget.attempts > 0 && input.reproductionBudget.reproduced < input.reproductionBudget.attempts
  );
  const baseConfidence = isTenantLeak ? 0.95 : isDuplicateMutation ? 0.93 : 0.82;

  return {
    $schema: "ghost-invasion/finding@1",
    id: input.id,
    title: tenantLeakProven
      ? "A user can read another tenant's private project"
      : duplicateProven
        ? "Double-click on Create creates duplicate projects"
        : titleFromMessage(input.group[0]?.message),
    category: isFlaky ? "flaky" : "confirmed-bug",
    severity: isTenantLeak || isDuplicateMutation ? "critical" : "high",
    confidence: isFlaky ? Math.min(baseConfidence, 0.7) : baseConfidence,
    invariant: input.invariant,
    affected: { surfaceId: mutation ?? route, route, api: mutation },
    reproducedAcross: { personas: personas.size, inputProfiles: inputProfiles.size, seeds: seeds.size },
    occurrences: input.group.length,
    pristinePassed: input.pristinePassed,
    reproductionRate: reproductionRateFor(input.reproductionBudget, input.group.length),
    mockDependent: input.mockDependent,
    signals: [...signalsFor(input.artifacts), ...reproductionSignals(input.reproductionBudget)],
    expected:
      tenantLeakProven
        ? "The response only contains resources owned by the authenticated user."
        : typeof expectedInserted === "number"
        ? `${expectedInserted} inserted row(s) for ${input.artifacts.dbDiff?.table ?? "the target table"}`
        : "The journey invariant remains true.",
    actual:
      tenantLeakProven
        ? input.group[0]?.message ?? "A private resource owned by another tenant was visible."
        : typeof actualInserted === "number"
        ? `${actualInserted} inserted row(s) observed for ${input.artifacts.dbDiff?.table ?? "the target table"}`
        : input.group[0]?.message ?? "The journey failed.",
    evidence: input.artifacts.evidence.length > 0 ? input.artifacts.evidence : ["events.jsonl"],
    reproSteps: `reproduction-steps/${input.id}.md`,
    minimalRepro: null,
    suggestedFix: tenantLeakProven
      ? "Add an owner/tenant check before returning the resource and keep that check close to the route/load handler."
      : duplicateProven
      ? "Add an idempotency key for create requests and disable submit after the first click."
      : "Inspect the failing journey evidence and make the invariant deterministic before promoting this finding.",
    generatedTest: `generated-tests/${input.id}.spec.ts`
  };
}

function reproductionRateFor(reproduction: { attempts: number; reproduced: number; otherFailures: number } | undefined, occurrences: number): string {
  if (reproduction && reproduction.attempts > 0) {
    return `${reproduction.reproduced}/${reproduction.attempts} budget reruns`;
  }
  return `${occurrences}/${occurrences} attempts`;
}

function reproductionSignals(reproduction: { attempts: number; reproduced: number; otherFailures: number } | undefined): string[] {
  if (!reproduction || reproduction.attempts === 0) return [];
  const signals = [`reproduction-rate:${reproduction.reproduced}/${reproduction.attempts}`];
  if (reproduction.otherFailures > 0) signals.push(`reproduction-other-failures:${reproduction.otherFailures}`);
  if (reproduction.reproduced < reproduction.attempts) signals.push("flaky-reproduction");
  return signals;
}

function signalsFor(artifacts: EvidenceArtifacts): string[] {
  const signals = ["assertion_failed"];
  if (artifacts.kinds.has("db_diff")) signals.push("db_diff_bad");
  if (artifacts.kinds.has("network_response_body")) signals.push("network_response_body");
  if (artifacts.kinds.has("db_owner_check")) signals.push("db_owner_check");
  if (artifacts.kinds.has("trace")) signals.push("trace_available");
  if (artifacts.kinds.has("video")) signals.push("replay_available");
  return signals;
}

function failureSeeds(
  summary: SwarmSummaryForClassifier,
  events: EvidenceEvent[],
  stepErrors: Map<string, StepErrorEvent>
): FailureSeed[] {
  if (summary.failures && summary.failures.length > 0) return summary.failures;

  const starts = new Map<string, EvidenceEvent>();
  for (const event of events) {
    if (event.type === "drone-start" && typeof event.droneId === "string") starts.set(event.droneId, event);
  }

  return events
    .filter((event) => event.type === "drone-failed" && event.attempt === "normal" && typeof event.droneId === "string")
    .filter((event) => !String(event.droneId).startsWith("pristine."))
    .map((event) => {
      const start = starts.get(String(event.droneId));
      const stepError = stepErrors.get(String(event.droneId));
      const journeyId = String(start?.journeyId ?? "unknown-journey");
      const personaId = String(start?.personaId ?? "unknown-persona");
      const message = String(event.message ?? stepError?.message ?? "unknown failure");
      return {
        droneId: String(event.droneId),
        journeyId,
        personaId,
        seed: Number(start?.seed ?? 0),
        message,
        fingerprint: failureFingerprint({ journeyId, personaId, stepType: stepError?.primitive, message })
      };
    });
}

function latestStepErrors(events: EvidenceEvent[]): Map<string, StepErrorEvent> {
  const errors = new Map<string, StepErrorEvent>();
  for (const event of events) {
    if (event.type !== "step-error" || typeof event.droneId !== "string") continue;
    errors.set(event.droneId, event as StepErrorEvent);
  }
  return errors;
}

function pristineResultsFromEvents(events: EvidenceEvent[]): PristineSentinelResult[] {
  return events
    .filter((event) => event.type === "pristine-sentinel" && typeof event.journeyId === "string")
    .map((event) => ({
      journeyId: String(event.journeyId),
      ok: Boolean(event.ok),
      droneId: String(event.droneId ?? `pristine.${event.journeyId}`),
      message: typeof event.message === "string" ? event.message : undefined
    }));
}

function pristineByJourney(results: PristineSentinelResult[]): Map<string, boolean> {
  return new Map(results.map((result) => [result.journeyId, result.ok]));
}

async function artifactsForGroup(runRoot: string, group: FailureSeed[]): Promise<EvidenceArtifacts> {
  const evidence = new Set<string>();
  const kinds = new Set<string>();
  let dbDiff: DbDiffArtifact | null = null;

  for (const failure of group) {
    for (const droneId of [failure.droneId, `${failure.droneId}.trace`]) {
      const dir = join(runRoot, "evidence", sanitizePathSegment(droneId));
      const candidates = [
        { file: "db-diff.json", kind: "db_diff" },
        { file: "response-body.json", kind: "network_response_body" },
        { file: "network-response-body.json", kind: "network_response_body" },
        { file: "db-owner-check.json", kind: "db_owner_check" },
        { file: "owner-check.json", kind: "db_owner_check" },
        { file: "trace.zip", kind: "trace" },
        { file: "video.webm", kind: "video" },
        { file: "network.har", kind: "har" },
        { file: "console.jsonl", kind: "console_log" },
        { file: "fail.png", kind: "screenshot" },
        { file: "fail-cheap.png", kind: "screenshot" }
      ];
      for (const candidate of candidates) {
        const path = join(dir, candidate.file);
        if (!(await exists(path))) continue;
        evidence.add(relative(runRoot, path).replace(/\\/g, "/"));
        kinds.add(candidate.kind);
        if (candidate.kind === "trace" || candidate.kind === "video") kinds.add("replay");
        if (candidate.kind === "db_diff" && dbDiff === null) {
          dbDiff = JSON.parse(await readFile(path, "utf8")) as DbDiffArtifact;
        }
      }
    }
  }

  return { evidence: [...evidence].sort(), kinds, dbDiff };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(path: string): Promise<EvidenceEvent[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  const events: EvidenceEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    events.push(JSON.parse(trimmed) as EvidenceEvent);
  }
  return events;
}

function claimKindFor(invariant: string, evidenceKinds: Set<string>): ConfidenceCeilingInput["claimKind"] {
  if (invariant.includes("tenant") || invariant.startsWith("auth.") || invariant.startsWith("permission.")) return "tenant-permission";
  if (invariant.startsWith("ux.")) return "ux-trap";
  if (evidenceKinds.has("db_diff") || invariant.startsWith("mutation.") || invariant.startsWith("data.")) return "state-change";
  return "unknown";
}

function proofCompleteFor(claimKind: ConfidenceCeilingInput["claimKind"], evidenceKinds: Set<string>, requiredEvidence: string[]): boolean {
  if (requiredEvidence.length > 0) {
    return requiredEvidence.every((kind) => evidenceRequirementSatisfied(kind, evidenceKinds));
  }

  const hasReplay = evidenceKinds.has("trace") || evidenceKinds.has("video") || evidenceKinds.has("replay");
  switch (claimKind) {
    case "state-change":
      return evidenceKinds.has("db_diff") && hasReplay;
    case "tenant-permission":
      return evidenceKinds.has("network_response_body") && evidenceKinds.has("db_owner_check") && evidenceKinds.has("trace");
    case "ux-trap":
      return hasReplay && (evidenceKinds.has("screenshot") || evidenceKinds.has("trace"));
    case "runtime-error":
      return evidenceKinds.has("console_log") && hasReplay;
    case "performance":
      return evidenceKinds.has("timing") && evidenceKinds.has("concurrency");
    default:
      return hasReplay;
  }
}

function evidenceRequirementSatisfied(required: string, evidenceKinds: Set<string>): boolean {
  switch (required) {
    case "replay":
      return evidenceKinds.has("replay") || evidenceKinds.has("trace") || evidenceKinds.has("video");
    case "browser_trace":
    case "trace":
      return evidenceKinds.has("trace");
    case "video":
      return evidenceKinds.has("video");
    default:
      return evidenceKinds.has(required);
  }
}

function personaById(plan: GhostInvasionPlan, personaId: string): Persona | undefined {
  return plan.personas.find((persona) => persona.id === personaId);
}

function titleFromMessage(message: string | undefined): string {
  const cleaned = (message ?? "Journey invariant failed").replace(/\s+/g, " ").trim();
  return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
}

function findingId(index: number): string {
  return `F-${String(index).padStart(3, "0")}`;
}

function roundConfidence(value: number): number {
  return Math.round(value * 100) / 100;
}

function plural(count: number, singular: string, pluralWord: string): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

// No finding may read as a confirmed bug without a bound proof artifact. `evidence`
// always carries at least the `events.jsonl` backstop (schema minItems:1), so "no bound
// proof" means nothing beyond that placeholder. Such a finding is forced to
// needs-human-review and can never surface as confirmed (S-029, Brief R1/E2).
export function enforceEvidenceGuardrail(finding: Finding): Finding {
  const hasBoundProof = finding.evidence.some((entry) => entry !== "events.jsonl");
  if (hasBoundProof || finding.category === "needs-human-review") return finding;
  return {
    ...finding,
    category: "needs-human-review",
    signals: [...new Set([...finding.signals, "ceiling:no-bound-evidence"])]
  };
}

export function compareFindings(a: Finding, b: Finding): number {
  const severity = severityRank[b.severity] - severityRank[a.severity];
  if (severity !== 0) return severity;
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const breadthA = a.reproducedAcross.personas + a.reproducedAcross.seeds;
  const breadthB = b.reproducedAcross.personas + b.reproducedAcross.seeds;
  if (breadthB !== breadthA) return breadthB - breadthA;
  // Stable, content-addressed tiebreak so equal-rank findings never reorder run-to-run.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
