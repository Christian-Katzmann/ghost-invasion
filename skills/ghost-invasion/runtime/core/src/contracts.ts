import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Invariant } from "./schemas/invariant.js";
import type { Journey } from "./schemas/journey.js";
import type { Surface } from "./schemas/surface.js";

export interface InvariantLedger {
  schemaVersion: "1.0";
  invariants: Invariant[];
}

export interface RiskPackEvidenceRule {
  invariant: string;
  severity: Invariant["severity"];
  requiredEvidence: string[];
}

export interface RiskPack {
  schemaVersion: "1.0";
  id: string;
  name: string;
  description: string;
  invariants: string[];
  personas: string[];
  journeys: string[];
  evidenceRules: RiskPackEvidenceRule[];
}

export interface AttachedInvariant {
  invariantId: string;
  reason: string;
}

export const defaultInvariantLedger: InvariantLedger = {
  schemaVersion: "1.0",
  invariants: [
    {
      $schema: "ghost-invasion/invariant@1",
      id: "auth.no-cross-tenant-read",
      class: "hard",
      severity: "critical",
      statement: "A user must never read another tenant's private objects.",
      evidenceRequired: ["network_response_body", "db_owner_check", "trace"],
      autoAttachWhen: "auth detected AND owned resources detected"
    },
    {
      $schema: "ghost-invasion/invariant@1",
      id: "mutation.idempotent-create",
      class: "hard",
      severity: "high",
      statement: "Repeating the same create must not create duplicate records.",
      evidenceRequired: ["db_diff", "replay"],
      autoAttachWhen: "create form/mutation detected"
    },
    {
      $schema: "ghost-invasion/invariant@1",
      id: "ux.no-dead-end-after-error",
      class: "soft",
      severity: "medium",
      statement: "After a failed action, the user must have a visible recovery path.",
      evidenceRequired: ["screenshot", "trace"],
      autoAttachWhen: "always"
    },
    {
      $schema: "ghost-invasion/invariant@1",
      id: "ux.mobile-first-run-completes",
      class: "soft",
      severity: "medium",
      statement: "A mobile first-run user must be able to complete the critical path without layout or recovery traps.",
      evidenceRequired: ["screenshot", "trace"],
      autoAttachWhen: "mobile persona OR first-run/onboarding route detected"
    },
    {
      $schema: "ghost-invasion/invariant@1",
      id: "mutation.multi-tab-consistency",
      class: "hard",
      severity: "high",
      statement: "Concurrent tabs must not overwrite, duplicate, or stale-write shared state without explicit conflict handling.",
      evidenceRequired: ["db_diff", "replay"],
      autoAttachWhen: "stateful mutation detected"
    },
    {
      $schema: "ghost-invasion/invariant@1",
      id: "data.shape-preserved",
      class: "hard",
      severity: "high",
      statement: "Required and user-entered fields must survive create/edit/readback without silent coercion or loss.",
      evidenceRequired: ["db_diff", "network_response_body", "replay"],
      autoAttachWhen: "form/api input shape detected"
    }
  ]
};

const packIdPattern = /^[a-z0-9][a-z0-9-]*$/;

export function defaultContractYaml(): string {
  return stringify(defaultInvariantLedger, { lineWidth: 120 });
}

export function contractPath(projectRoot = process.cwd()): string {
  return join(projectRoot, ".ghost", "contracts", "ghost.contract.yaml");
}

export async function writeDefaultInvariantLedger(projectRoot = process.cwd()): Promise<string> {
  const path = contractPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, defaultContractYaml(), "utf8");
  return path;
}

export async function loadInvariantLedger(projectRoot = process.cwd()): Promise<InvariantLedger> {
  const path = contractPath(projectRoot);
  try {
    return normalizeLedger(parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultInvariantLedger;
    throw error;
  }
}

export async function listRiskPacks(projectRoot = process.cwd()): Promise<string[]> {
  const ids = new Set<string>();
  for (const dir of [projectPackDir(projectRoot), bundledPackDir()]) {
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries) {
      const match = /^([a-z0-9][a-z0-9-]*)\.ya?ml$/.exec(entry);
      if (match) ids.add(match[1]!);
    }
  }
  return [...ids].sort();
}

export async function loadRiskPack(packId: string, options: { projectRoot?: string } = {}): Promise<RiskPack> {
  const id = packId.trim();
  if (!packIdPattern.test(id)) {
    throw new Error(`Invalid risk pack id "${packId}". Use lowercase words separated by hyphens.`);
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  const candidates = [join(projectPackDir(projectRoot), `${id}.yaml`), join(bundledPackDir(), `${id}.yaml`)];
  for (const candidate of candidates) {
    try {
      return normalizeRiskPack(parse(await readFile(candidate, "utf8")), id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const available = await listRiskPacks(projectRoot);
  throw new Error(`Unknown risk pack "${id}". Available packs: ${available.join(", ") || "none"}.`);
}

export async function applySelectedRiskPackToPlan(
  plan: GhostInvasionPlan,
  options: { projectRoot?: string; packId?: string } = {}
): Promise<GhostInvasionPlan> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const pack = await loadRiskPack(options.packId ?? plan.pack, { projectRoot });
  const ledger = await loadInvariantLedger(projectRoot);
  return applyRiskPackToPlan(plan, pack, ledger);
}

export function applyRiskPackToPlan(plan: GhostInvasionPlan, pack: RiskPack, ledger: InvariantLedger): GhostInvasionPlan {
  const packInvariantIds = new Set(pack.invariants);
  const ledgerInvariantIds = new Set(ledger.invariants.map((invariant) => invariant.id));
  const enabledInvariantIds = new Set([...packInvariantIds].filter((id) => ledgerInvariantIds.has(id)));

  return {
    ...plan,
    pack: pack.id,
    journeys: plan.journeys.map((journey) => ({
      ...journey,
      invariantsTested: mergeIds(journey.invariantsTested, inferJourneyInvariantIds(journey, enabledInvariantIds))
    }))
  };
}

export function attachInvariantsToSurfaces(
  surfaces: Surface[],
  ledger: InvariantLedger = defaultInvariantLedger,
  pack?: RiskPack
): Record<string, AttachedInvariant[]> {
  const allowed = pack ? new Set(pack.invariants) : null;
  const result: Record<string, AttachedInvariant[]> = {};

  for (const surface of surfaces) {
    const attached: AttachedInvariant[] = [];
    for (const invariant of ledger.invariants) {
      if (allowed && !allowed.has(invariant.id)) continue;
      const reason = attachReason(surface, invariant);
      if (reason) attached.push({ invariantId: invariant.id, reason });
    }
    result[surface.id] = attached;
  }

  return result;
}

export function classForInvariantId(ledger: InvariantLedger, invariantId: string): Invariant["class"] | "unknown" {
  return ledger.invariants.find((invariant) => invariant.id === invariantId)?.class ?? classForInvariantIdFallback(invariantId);
}

export function evidenceRequiredForInvariant(
  ledger: InvariantLedger,
  invariantId: string,
  pack?: RiskPack | null
): string[] {
  const packRule = pack?.evidenceRules.find((rule) => rule.invariant === invariantId);
  if (packRule) return packRule.requiredEvidence;
  return ledger.invariants.find((invariant) => invariant.id === invariantId)?.evidenceRequired ?? [];
}

export function severityForInvariant(ledger: InvariantLedger, invariantId: string, pack?: RiskPack | null): Invariant["severity"] | null {
  const packRule = pack?.evidenceRules.find((rule) => rule.invariant === invariantId);
  if (packRule) return packRule.severity;
  return ledger.invariants.find((invariant) => invariant.id === invariantId)?.severity ?? null;
}

function projectPackDir(projectRoot: string): string {
  return join(projectRoot, ".ghost", "contracts", "packs");
}

function bundledPackDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
}

function normalizeLedger(input: unknown): InvariantLedger {
  const record = asRecord(input, "ghost.contract.yaml");
  const invariants = asArray(record.invariants, "invariants").map((item) => normalizeInvariant(item));
  return { schemaVersion: "1.0", invariants };
}

function normalizeInvariant(input: unknown): Invariant {
  const record = asRecord(input, "invariant");
  const invariant: Invariant = {
    $schema: "ghost-invasion/invariant@1",
    id: stringField(record.id, "invariant.id"),
    class: enumField(record.class, ["hard", "soft"], "invariant.class"),
    severity: enumField(record.severity, ["critical", "high", "medium", "low", "info"], "invariant.severity"),
    statement: stringField(record.statement, "invariant.statement"),
    evidenceRequired: stringArray(record.evidenceRequired, "invariant.evidenceRequired"),
    autoAttachWhen: stringField(record.autoAttachWhen, "invariant.autoAttachWhen")
  };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(invariant.id)) {
    throw new Error(`Invalid invariant id "${invariant.id}".`);
  }
  return invariant;
}

function normalizeRiskPack(input: unknown, expectedId: string): RiskPack {
  const record = asRecord(input, `risk pack ${expectedId}`);
  const id = stringField(record.id, "riskPack.id");
  if (id !== expectedId) throw new Error(`Risk pack file for "${expectedId}" declares id "${id}".`);
  return {
    schemaVersion: "1.0",
    id,
    name: stringField(record.name, "riskPack.name"),
    description: stringField(record.description, "riskPack.description"),
    invariants: stringArray(record.invariants, "riskPack.invariants"),
    personas: stringArray(record.personas, "riskPack.personas"),
    journeys: stringArray(record.journeys, "riskPack.journeys"),
    evidenceRules: asArray(record.evidenceRules, "riskPack.evidenceRules").map((item) => normalizeEvidenceRule(item))
  };
}

function normalizeEvidenceRule(input: unknown): RiskPackEvidenceRule {
  const record = asRecord(input, "riskPack.evidenceRule");
  return {
    invariant: stringField(record.invariant, "riskPack.evidenceRule.invariant"),
    severity: enumField(record.severity, ["critical", "high", "medium", "low", "info"], "riskPack.evidenceRule.severity"),
    requiredEvidence: stringArray(record.requiredEvidence, "riskPack.evidenceRule.requiredEvidence")
  };
}

function attachReason(surface: Surface, invariant: Invariant): string | null {
  if (invariant.id === "auth.no-cross-tenant-read") {
    return surface.requiresAuth && ownedResourceSurface(surface) ? "auth detected AND owned resources detected" : null;
  }
  if (invariant.id === "mutation.idempotent-create") {
    return createMutationSurface(surface) ? "create form/mutation detected" : null;
  }
  if (invariant.id === "ux.no-dead-end-after-error") return "always";
  if (invariant.id === "ux.mobile-first-run-completes") {
    return mobileFirstRunSurface(surface) ? "mobile persona OR first-run/onboarding route detected" : null;
  }
  if (invariant.id === "mutation.multi-tab-consistency") {
    return statefulMutationSurface(surface) ? "stateful mutation detected" : null;
  }
  if (invariant.id === "data.shape-preserved") {
    return dataShapeSurface(surface) ? "form/api input shape detected" : null;
  }

  const rule = invariant.autoAttachWhen.toLowerCase();
  if (rule === "always") return invariant.autoAttachWhen;
  if (rule.includes("auth") && !surface.requiresAuth) return null;
  if (rule.includes("create") && !createMutationSurface(surface)) return null;
  if (rule.includes("mobile") && !mobileFirstRunSurface(surface)) return null;
  if (rule.includes("stateful") && !statefulMutationSurface(surface)) return null;
  if ((rule.includes("data") || rule.includes("input")) && !dataShapeSurface(surface)) return null;
  return rule.includes("auth") || rule.includes("create") || rule.includes("mobile") || rule.includes("stateful") || rule.includes("data")
    ? invariant.autoAttachWhen
    : null;
}

function ownedResourceSurface(surface: Surface): boolean {
  const text = surfaceText(surface);
  const looksOwned = /\b(project|tenant|account|workspace|team|org|organization|customer|order|invoice|profile|member|owner)\b/.test(text);
  return looksOwned && (surface.routes.some((route) => route.dynamic) || surface.requiresRole.length > 0 || surface.type === "core");
}

function createMutationSurface(surface: Surface): boolean {
  const text = surfaceText(surface);
  const mutationKind = ["mutation", "api", "server-action", "form-post"].includes(surface.kind);
  const canCreate = surface.methods.includes("POST") || /(^|\W)(create|new|submit|save|add)(\W|$)/.test(text);
  return mutationKind && canCreate;
}

function mobileFirstRunSurface(surface: Surface): boolean {
  const text = surfaceText(surface);
  return /\b(mobile|first-run|onboard|onboarding|signup|sign-up|welcome|get-started|getting-started|profile|account)\b/.test(text);
}

function statefulMutationSurface(surface: Surface): boolean {
  const text = surfaceText(surface);
  const mutatesState =
    surface.isDestructive ||
    surface.methods.some((method) => ["POST", "PUT", "PATCH", "DELETE"].includes(method)) ||
    ["mutation", "api", "server-action", "form-post", "resource-route"].includes(surface.kind);
  return mutatesState && /\b(create|edit|update|save|delete|submit|project|task|order|invoice|profile|settings|cart)\b/.test(text);
}

function dataShapeSurface(surface: Surface): boolean {
  const text = surfaceText(surface);
  return (
    surface.inputs.length > 0 ||
    surface.methods.some((method) => ["POST", "PUT", "PATCH"].includes(method)) ||
    /\b(form|field|input|schema|shape|json|csv|import|upload|profile|settings)\b/.test(text)
  );
}

function surfaceText(surface: Surface): string {
  return [
    surface.id,
    surface.name,
    surface.type,
    surface.kind,
    surface.mutationTier,
    ...surface.routes.map((route) => route.path),
    ...surface.methods,
    ...surface.inputs.map((input) => input.name)
  ]
    .join(" ")
    .toLowerCase();
}

function inferJourneyInvariantIds(journey: Journey, enabledInvariantIds: Set<string>): string[] {
  const text = [
    journey.id,
    journey.name,
    journey.goal,
    ...journey.anchors.routes,
    ...journey.anchors.mutations,
    ...journey.idealPath
  ]
    .join(" ")
    .toLowerCase();
  const ids: string[] = [];

  if (enabledInvariantIds.has("auth.no-cross-tenant-read") && /tenant|permission|owner|other user|cross|project\/\[id\]|projects\/:id/.test(text)) {
    ids.push("auth.no-cross-tenant-read");
  }
  if (enabledInvariantIds.has("mutation.idempotent-create") && /double|create|post|submit|save|idempotent/.test(text)) {
    ids.push("mutation.idempotent-create");
  }
  if (enabledInvariantIds.has("ux.no-dead-end-after-error") && /ux|spinner|error|dead-end|failed|recovery|slow/.test(text)) {
    ids.push("ux.no-dead-end-after-error");
  }
  if (enabledInvariantIds.has("ux.mobile-first-run-completes") && /mobile|first-run|onboard|signup|welcome|slow|small viewport/.test(text)) {
    ids.push("ux.mobile-first-run-completes");
  }
  if (enabledInvariantIds.has("mutation.multi-tab-consistency") && /multi-tab|newtab|tab|concurrent|stale|overwrite|conflict|race/.test(text)) {
    ids.push("mutation.multi-tab-consistency");
  }
  if (enabledInvariantIds.has("data.shape-preserved") && /shape|field|unicode|roundtrip|required|form|schema|csv|import|profile|settings/.test(text)) {
    ids.push("data.shape-preserved");
  }

  return ids;
}

function mergeIds(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])];
}

function classForInvariantIdFallback(invariantId: string): Invariant["class"] | "unknown" {
  if (invariantId.startsWith("ux.")) return "soft";
  if (
    invariantId.startsWith("mutation.") ||
    invariantId.startsWith("auth.") ||
    invariantId.startsWith("permission.") ||
    invariantId.startsWith("data.")
  ) {
    return "hard";
  }
  return "unknown";
}

function asRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
  throw new Error(`${label} must be an object.`);
}

function asArray(input: unknown, label: string): unknown[] {
  if (Array.isArray(input)) return input;
  throw new Error(`${label} must be an array.`);
}

function stringField(input: unknown, label: string): string {
  if (typeof input === "string" && input.trim()) return input.trim();
  throw new Error(`${label} must be a non-empty string.`);
}

function stringArray(input: unknown, label: string): string[] {
  return asArray(input, label).map((item) => stringField(item, label));
}

function enumField<const T extends readonly string[]>(input: unknown, values: T, label: string): T[number] {
  if (typeof input === "string" && values.includes(input)) return input;
  throw new Error(`${label} must be one of: ${values.join(", ")}.`);
}
