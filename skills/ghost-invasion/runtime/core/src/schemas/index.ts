export * from "./repo-scan.js";
export * from "./surface.js";
export * from "./persona.js";
export * from "./invariant.js";
export * from "./journey.js";
export * from "./finding.js";
export * from "./report.js";
export * from "./safety-verdict.js";
export * from "./ghost-plan.js";

import { repoScanSchema } from "./repo-scan.js";
import { surfaceSchema } from "./surface.js";
import { personaSchema } from "./persona.js";
import { invariantSchema } from "./invariant.js";
import { journeySchema } from "./journey.js";
import { findingSchema } from "./finding.js";
import { reportSchema } from "./report.js";
import { safetyVerdictSchema } from "./safety-verdict.js";
import { ghostPlanSchema } from "./ghost-plan.js";

export const versionedSchemas = {
  repoScan: repoScanSchema,
  surface: surfaceSchema,
  persona: personaSchema,
  invariant: invariantSchema,
  journey: journeySchema,
  finding: findingSchema,
  report: reportSchema,
  safetyVerdict: safetyVerdictSchema,
  ghostPlan: ghostPlanSchema
} as const;

