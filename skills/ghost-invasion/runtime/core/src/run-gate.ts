// run-gate.ts — the pre-run safety gate.
//
// Responsibility: re-evaluate the canonical safety verdict against the LIVE target
// at the moment of a real run, and fail closed before any drone, API-tier request,
// or browser pool can touch the target. This is the enforcement point the verdict in
// safety.ts produces but never previously reached on the `run` path.
//
// Obligations (Brief red lines R4/R2/R3):
//   - block a `block` verdict (prod target, live block-class secret, or a mutating run
//     with no trusted reset/isolation boundary) before mutation can happen;
//   - require, on EVERY mutating run, that the loaded plan's approvedPlanHash is non-null
//     AND equals planHash(plan) — a tampered or unapproved plan fails closed. This gate is
//     only ever reached on the mutating run path (dry-runs return before it), so a forged
//     plan field (e.g. a hand-edited egress.proven:true) can never ride through unsigned;
//   - bind approval to the run mode: the effective mode must equal the mode the plan was
//     compiled and approved for. The runner rewrites an approved-quick plan into an
//     elevated mode (preparePlanForRunMode) while the on-disk hash still matches, so the
//     hash alone is mode-blind — re-check the mode and fail closed on a mismatch;
//   - validate the loaded plan against ghostPlanSchema so a malformed plan never runs.
//
// Scope note: the egress proof consumed here is the one recorded in the plan at plan
// time. Running a fresh container canary during the run is batch 03's job; this module
// only routes the existing verdict onto the run path.

import { Ajv } from "ajv/dist/ajv.js";
import { defaultEgressAllowlist, type EgressCanaryProof } from "./egress.js";
import type { GhostResetConfig } from "./manual-config.js";
import { planHash } from "./planner.js";
import { normalizeRunMode } from "./run-modes.js";
import { evaluateSafety } from "./safety.js";
import { ghostPlanSchema, type GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { SafetyVerdict } from "./schemas/safety-verdict.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validatePlan = ajv.compile(ghostPlanSchema);

// Run modes that may never proceed against an unapproved plan, mirroring the
// approval set in safety.ts evaluateSafety().
const approvalRequiredModes = new Set(["deep", "chaos", "payments", "concurrency", "permission"]);

export class RunGateError extends Error {
  readonly verdict?: SafetyVerdict;

  constructor(message: string, verdict?: SafetyVerdict) {
    super(message);
    this.name = "RunGateError";
    this.verdict = verdict;
  }
}

export interface RunGateInput {
  // The plan exactly as loaded from disk — hashed and schema-checked verbatim.
  loadedPlan: unknown;
  projectRoot: string;
  // The live target resolved by the runner (plan/--base-url/agent memory).
  baseUrl: string;
  // The effective run mode after flag/plan resolution.
  mode: string;
  // The registered reset boundary (out-of-band), the trusted reset source.
  reset: GhostResetConfig | null;
  allowProductionTarget?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunGateResult {
  verdict: SafetyVerdict;
  approvalRequired: boolean;
  planHash: string;
}

// Validate a freshly loaded plan against ghostPlanSchema and fail closed if it is
// malformed. Returns the same object typed as a plan. Call this before any code uses
// the plan so a truncated/hand-edited/garbage plan can never reach a run.
export function validateLoadedPlan(plan: unknown): GhostInvasionPlan {
  if (!validatePlan(plan)) {
    throw new RunGateError(`run blocked: plan failed ghostPlanSchema validation (${ajv.errorsText(validatePlan.errors)})`);
  }
  return plan as GhostInvasionPlan;
}

function egressProofFromPlan(plan: GhostInvasionPlan): EgressCanaryProof {
  const egress = plan.safety.egress;
  return {
    mode: "container-firewall",
    proven: Boolean(egress.proven),
    canaryMatrix: egress.proven ? { plan: "proven-at-plan-time" } : {},
    allowlist: egress.allowlist.length > 0 ? egress.allowlist : [...defaultEgressAllowlist],
    dockerAvailable: Boolean(egress.proven),
    errors: egress.proven ? [] : ["egress trap not proven in the approved plan"]
  };
}

// Re-evaluate safety against the live target and fail closed before any mutation.
// Throws RunGateError when the run must not proceed.
export async function assertRunAllowed(input: RunGateInput): Promise<RunGateResult> {
  const plan = validateLoadedPlan(input.loadedPlan);

  const verdict = await evaluateSafety({
    baseUrl: input.baseUrl,
    cwd: input.projectRoot,
    mode: input.mode,
    mutating: true,
    resetStrategy: input.reset?.strategy ?? "none",
    dataIsolation: input.reset?.isolation ?? "unknown",
    allowProductionTarget: input.allowProductionTarget,
    approvedPlanHash: plan.approvedPlanHash,
    egressProof: egressProofFromPlan(plan),
    env: input.env
  });

  if (verdict.verdict === "block") {
    throw new RunGateError(`run blocked by safety verdict: ${verdict.explain}`, verdict);
  }

  // Every mutating run must carry a valid plan approval. This is what makes
  // plan.safety.egress.proven (and every other safety field) trustworthy: the approval
  // hash signs the plan, so a hand-edited field on an unapproved — or post-approval-edited
  // — plan can never ride through (F5). The integrity check runs first so a tampered plan
  // reports the precise "edited after approval" reason before the mode binding below.
  const expectedHash = planHash(plan);
  if (!plan.approvedPlanHash || plan.approvedPlanHash !== expectedHash) {
    throw new RunGateError(
      plan.approvedPlanHash
        ? "run blocked: plan approval hash does not match the plan on disk (the approved plan was edited after approval)"
        : `run blocked: a mutating run requires an approved plan; run "ghost-invasion plan --approve" first`,
      verdict
    );
  }

  // Approval binds to the mode the plan was compiled and approved for. The runner can
  // rewrite an approved-quick plan into an elevated mode (preparePlanForRunMode) while the
  // on-disk hash still matches, so the signed hash alone is mode-blind. Re-approval is
  // required whenever the effective run mode differs from the approved plan's mode (F1):
  // the operator approved a specific intensity of run and an elevated mode must be
  // re-approved before it can execute.
  const approvedMode = normalizeRunMode(plan.mode);
  const effectiveMode = normalizeRunMode(input.mode);
  if (effectiveMode !== approvedMode) {
    throw new RunGateError(
      `run blocked: this run uses "${effectiveMode}" mode but the plan on disk was approved for "${approvedMode}" mode; ` +
        `re-approve at this mode (run "ghost-invasion plan --mode ${effectiveMode} --approve") before running it`,
      verdict
    );
  }

  const approvalRequired = verdict.approvalRequired || approvalRequiredModes.has(input.mode);
  return { verdict, approvalRequired, planHash: expectedHash };
}
