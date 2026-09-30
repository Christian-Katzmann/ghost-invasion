import type { Persona } from "./persona.js";
import type { Journey } from "./journey.js";
import type { JsonSchema } from "./json-schema.js";
import type { SafetyVerdict } from "./safety-verdict.js";
import { personaSchema } from "./persona.js";
import { journeySchema } from "./journey.js";

export interface GhostInvasionPlan {
  $schema: "ghost-invasion/plan@1";
  createdAt: string;
  target: { baseUrl: string; stack: string; auth: string };
  mode: string;
  pack: string;
  seed: number;
  safety: {
    targetRisk: SafetyVerdict["targetRisk"];
    hardStop: boolean;
    egress: { mode: string; proven: boolean; allowlist: string[] };
    // Reuses the verdict's typed item shape (planner stamps verdict.liveSecrets
    // here), so consumers read secret.key directly with no defensive sniffing (S-034).
    liveSecrets: SafetyVerdict["liveSecrets"];
    mocksApplied: string[];
    dataReset: { strategy: string; isolation: string; destructiveAllowed: boolean };
    approvalRequired: boolean;
  };
  swarm: {
    browserConcurrency: number;
    browserWaves: number;
    totalBrowserSessions: number;
    apiTier: { enabled: boolean; engine: string; rps: number; targets: string[] };
    rateLimits: { rampMsPerContext: number; circuitBreaker: string };
  };
  personas: Persona[];
  journeys: Journey[];
  surfaceHash: string;
  approvedPlanHash: string | null;
}

export const ghostPlanSchema: JsonSchema = {
  $id: "ghost-invasion/plan@1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "createdAt",
    "target",
    "mode",
    "pack",
    "seed",
    "safety",
    "swarm",
    "personas",
    "journeys",
    "surfaceHash",
    "approvedPlanHash"
  ],
  properties: {
    $schema: { const: "ghost-invasion/plan@1" },
    createdAt: { type: "string" },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["baseUrl", "stack", "auth"],
      properties: {
        baseUrl: { type: "string" },
        stack: { type: "string" },
        auth: { type: "string" }
      }
    },
    mode: { type: "string" },
    pack: { type: "string" },
    seed: { type: "integer" },
    safety: {
      type: "object",
      additionalProperties: false,
      required: ["targetRisk", "hardStop", "egress", "liveSecrets", "mocksApplied", "dataReset", "approvalRequired"],
      properties: {
        targetRisk: { enum: ["local", "staging", "prod"] },
        hardStop: { type: "boolean" },
        approvalRequired: { type: "boolean" },
        egress: {
          type: "object",
          additionalProperties: false,
          required: ["mode", "proven", "allowlist"],
          properties: {
            mode: { type: "string" },
            proven: { type: "boolean" },
            allowlist: { type: "array", items: { type: "string" } }
          }
        },
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
        mocksApplied: { type: "array", items: { type: "string" } },
        dataReset: {
          type: "object",
          additionalProperties: false,
          required: ["strategy", "isolation", "destructiveAllowed"],
          properties: {
            strategy: { type: "string" },
            isolation: { type: "string" },
            destructiveAllowed: { type: "boolean" }
          }
        }
      }
    },
    swarm: {
      type: "object",
      additionalProperties: false,
      required: ["browserConcurrency", "browserWaves", "totalBrowserSessions", "apiTier", "rateLimits"],
      properties: {
        browserConcurrency: { type: "integer" },
        browserWaves: { type: "integer" },
        totalBrowserSessions: { type: "integer" },
        apiTier: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "engine", "rps", "targets"],
          properties: {
            enabled: { type: "boolean" },
            engine: { type: "string" },
            rps: { type: "integer" },
            targets: { type: "array", items: { type: "string" } }
          }
        },
        rateLimits: {
          type: "object",
          additionalProperties: false,
          required: ["rampMsPerContext", "circuitBreaker"],
          properties: {
            rampMsPerContext: { type: "integer" },
            circuitBreaker: { type: "string" }
          }
        }
      }
    },
    personas: { type: "array", minItems: 1, items: personaSchema },
    journeys: { type: "array", minItems: 1, items: journeySchema },
    surfaceHash: { type: "string" },
    approvedPlanHash: { type: ["string", "null"] }
  }
};

