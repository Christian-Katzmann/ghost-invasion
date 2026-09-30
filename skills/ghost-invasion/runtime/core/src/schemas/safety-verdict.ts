import type { JsonSchema } from "./json-schema.js";

export interface SafetyVerdict {
  $schema: "ghost-invasion/safety-verdict@1";
  schemaVersion: "1.0";
  verdict: "allow" | "allow-with-warnings" | "block" | "not-configured";
  targetRisk: "local" | "staging" | "prod";
  hardStop: boolean;
  reasons: string[];
  liveSecrets: Array<{ key: string; provider: string; severity: string; last4?: string }>;
  egress: {
    mode: "container-firewall" | "node-preload" | "process-proxy" | "attach-only";
    proven: boolean;
    canaryMatrix: Record<string, string>;
    allowlist: string[];
  };
  mocksApplied: Array<{ service: string; via: string }>;
  dataReset: { strategy: string; isolation: string; destructiveAllowed: boolean };
  rateLimits: { browserConcurrency: number; apiRps: number; memoryAware: boolean };
  flags: { allowProductionTarget: boolean };
  approvalRequired: boolean;
  approvedPlanHash: string | null;
  explain: string;
}

export const safetyVerdictSchema: JsonSchema = {
  $id: "ghost-invasion/safety-verdict@1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "schemaVersion",
    "verdict",
    "targetRisk",
    "hardStop",
    "reasons",
    "liveSecrets",
    "egress",
    "mocksApplied",
    "dataReset",
    "rateLimits",
    "flags",
    "approvalRequired",
    "approvedPlanHash",
    "explain"
  ],
  properties: {
    $schema: { const: "ghost-invasion/safety-verdict@1" },
    schemaVersion: { const: "1.0" },
    verdict: { enum: ["allow", "allow-with-warnings", "block", "not-configured"] },
    targetRisk: { enum: ["local", "staging", "prod"] },
    hardStop: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
    liveSecrets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "provider", "severity"],
        properties: {
          key: { type: "string" },
          provider: { type: "string" },
          severity: { type: "string" },
          last4: { type: "string" }
        }
      }
    },
    egress: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "proven", "canaryMatrix", "allowlist"],
      properties: {
        mode: { enum: ["container-firewall", "node-preload", "process-proxy", "attach-only"] },
        proven: { type: "boolean" },
        canaryMatrix: { type: "object", additionalProperties: { type: "string" } },
        allowlist: { type: "array", items: { type: "string" } }
      }
    },
    mocksApplied: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["service", "via"],
        properties: { service: { type: "string" }, via: { type: "string" } }
      }
    },
    dataReset: {
      type: "object",
      additionalProperties: false,
      required: ["strategy", "isolation", "destructiveAllowed"],
      properties: {
        strategy: { type: "string" },
        isolation: { type: "string" },
        destructiveAllowed: { type: "boolean" }
      }
    },
    rateLimits: {
      type: "object",
      additionalProperties: false,
      required: ["browserConcurrency", "apiRps", "memoryAware"],
      properties: {
        browserConcurrency: { type: "integer", minimum: 0 },
        apiRps: { type: "integer", minimum: 0 },
        memoryAware: { type: "boolean" }
      }
    },
    flags: {
      type: "object",
      additionalProperties: false,
      required: ["allowProductionTarget"],
      properties: { allowProductionTarget: { type: "boolean" } }
    },
    approvalRequired: { type: "boolean" },
    approvedPlanHash: { type: ["string", "null"] },
    explain: { type: "string" }
  }
};

