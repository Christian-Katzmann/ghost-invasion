import { Ajv } from "ajv/dist/ajv.js";
import type { JsonSchema } from "./json-schema.js";
import type { Finding } from "./finding.js";
import type { CostReport } from "../cost-model.js";
import { findingSchema } from "./finding.js";

// Honest run status. A report is only "clean" when the run actually completed, the
// egress trap was proven, no pristine-path sentinel was quarantined, and the evidence
// spine never degraded. Counting findings alone can render an aborted / dry-run /
// unproven / proof-incomplete run green (S-038, R1).
export interface RunStatus {
  state: "completed" | "dry-run" | "circuit-breaker";
  egressProven: boolean;
  quarantined: boolean;
  // True when the evidence spine silently degraded mid-run (e.g. ENOSPC/EISDIR): the
  // proof log is incomplete, so the run can no longer be trusted as clean (F4, R1).
  degraded: boolean;
  clean: boolean;
}

export interface ReportJson {
  $schema: "ghost-invasion/report@1";
  schemaVersion: "1.0";
  // Present and true only on a `run --demo-report`-derived run: every surface, finding,
  // and artifact is an illustrative fixture, not evidence from a live invasion. The live
  // dashboard renders a synthetic banner from this marker (S-049).
  synthetic?: boolean;
  runId: string;
  target: { url: string; stack: string; allowProductionTarget: boolean };
  invasion: {
    personas: number;
    journeys: number;
    pack: string;
    browserSessions: number;
    apiRequests: number;
    apiEndpointsHit: number;
    mode: string;
  };
  scale: { headline: string };
  runStatus: RunStatus;
  totals: { findings: number; critical: number; confirmedBugs: number; needsHumanReview: number; falsePositivesSuppressed: number };
  cost: CostReport;
  findings: Finding[];
  safety: {
    mockedServices: string[];
    dataResetStrategy: string;
    egress: { mode: string; proven: boolean };
    dangerousEnvKeysDetected: string[];
  };
}

export const reportSchema: JsonSchema = {
  $id: "ghost-invasion/report@1",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "schemaVersion", "runId", "target", "invasion", "scale", "runStatus", "totals", "cost", "findings", "safety"],
  properties: {
    $schema: { const: "ghost-invasion/report@1" },
    schemaVersion: { const: "1.0" },
    synthetic: { type: "boolean" },
    runId: { type: "string" },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["url", "stack", "allowProductionTarget"],
      properties: {
        url: { type: "string" },
        stack: { type: "string" },
        allowProductionTarget: { type: "boolean" }
      }
    },
    invasion: {
      type: "object",
      additionalProperties: false,
      required: ["personas", "journeys", "pack", "browserSessions", "apiRequests", "apiEndpointsHit", "mode"],
      properties: {
        personas: { type: "integer" },
        journeys: { type: "integer" },
        pack: { type: "string" },
        browserSessions: { type: "integer" },
        apiRequests: { type: "integer" },
        apiEndpointsHit: { type: "integer" },
        mode: { type: "string" }
      }
    },
    scale: {
      type: "object",
      additionalProperties: false,
      required: ["headline"],
      properties: { headline: { type: "string" } }
    },
    runStatus: {
      type: "object",
      additionalProperties: false,
      required: ["state", "egressProven", "quarantined", "degraded", "clean"],
      properties: {
        state: { enum: ["completed", "dry-run", "circuit-breaker"] },
        egressProven: { type: "boolean" },
        quarantined: { type: "boolean" },
        degraded: { type: "boolean" },
        clean: { type: "boolean" }
      }
    },
    totals: {
      type: "object",
      additionalProperties: false,
      required: ["findings", "critical", "confirmedBugs", "needsHumanReview", "falsePositivesSuppressed"],
      properties: {
        findings: { type: "integer" },
        critical: { type: "integer" },
        confirmedBugs: { type: "integer" },
        needsHumanReview: { type: "integer" },
        falsePositivesSuppressed: { type: "integer" }
      }
    },
    cost: {
      type: "object",
      additionalProperties: false,
      required: [
        "modelVersion",
        "currency",
        "budgetUsd",
        "estimatedUsd",
        "actualUsd",
        "variancePct",
        "withinBudget",
        "degraded",
        "degradations",
        "phases",
        "assumptions"
      ],
      properties: {
        modelVersion: { type: "string" },
        currency: { const: "USD" },
        budgetUsd: { type: ["number", "null"] },
        estimatedUsd: { type: "number" },
        actualUsd: { type: "number" },
        variancePct: { type: ["number", "null"] },
        withinBudget: { type: "boolean" },
        degraded: { type: "boolean" },
        degradations: { type: "array", items: { type: "string" } },
        phases: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "name",
              "unit",
              "plannedUnits",
              "actualUnits",
              "unitUsd",
              "estimatedUsd",
              "actualUsd",
              "metered",
              "skipped",
              "note"
            ],
            properties: {
              name: { type: "string" },
              unit: { type: "string" },
              plannedUnits: { type: "integer" },
              actualUnits: { type: "integer" },
              unitUsd: { type: "number" },
              estimatedUsd: { type: "number" },
              actualUsd: { type: "number" },
              metered: { type: "boolean" },
              skipped: { type: "boolean" },
              note: { type: "string" }
            }
          }
        },
        assumptions: {
          type: "object",
          additionalProperties: false,
          required: [
            "version",
            "currency",
            "llmInputUsdPer1kTokens",
            "llmOutputUsdPer1kTokens",
            "localBrowserSessionUsd",
            "localApiRequestUsd",
            "localReproductionAttemptUsd",
            "localReportRenderUsd"
          ],
          properties: {
            version: { type: "string" },
            currency: { const: "USD" },
            llmInputUsdPer1kTokens: { type: "number" },
            llmOutputUsdPer1kTokens: { type: "number" },
            localBrowserSessionUsd: { type: "number" },
            localApiRequestUsd: { type: "number" },
            localReproductionAttemptUsd: { type: "number" },
            localReportRenderUsd: { type: "number" }
          }
        }
      }
    },
    findings: { type: "array", items: findingSchema },
    safety: {
      type: "object",
      additionalProperties: false,
      required: ["mockedServices", "dataResetStrategy", "egress", "dangerousEnvKeysDetected"],
      properties: {
        mockedServices: { type: "array", items: { type: "string" } },
        dataResetStrategy: { type: "string" },
        egress: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "proven"],
          properties: { mode: { type: "string" }, proven: { type: "boolean" } }
        },
        dangerousEnvKeysDetected: { type: "array", items: { type: "string" } }
      }
    }
  }
};

// Derive an honest run status. `clean` is the single load-bearing boolean every
// surface keys off of: a run is only clean when it actually completed, egress was
// proven, nothing was quarantined, and the evidence spine never degraded.
export function deriveRunStatus(input: {
  state: RunStatus["state"];
  egressProven: boolean;
  quarantined: boolean;
  degraded: boolean;
}): RunStatus {
  return {
    state: input.state,
    egressProven: input.egressProven,
    quarantined: input.quarantined,
    degraded: input.degraded,
    clean: input.state === "completed" && input.egressProven && !input.quarantined && !input.degraded
  };
}

export class ReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportValidationError";
  }
}

// ajv is a runtime dependency that was previously wired only to the static example
// check. This validates a real report.json read from disk against the bundled schema
// so the exit-code decision fails closed on a truncated / hand-edited / critical-
// stripped report instead of trusting an unvalidated cast (S-020, R1).
const reportAjv = new Ajv({ allErrors: true, strict: false });
const validateReport = reportAjv.compile(reportSchema);

export function validateReportJson(value: unknown): ReportJson {
  if (!validateReport(value)) {
    throw new ReportValidationError(`report.json failed schema validation: ${reportAjv.errorsText(validateReport.errors)}`);
  }
  return value as ReportJson;
}
