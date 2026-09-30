import type { JsonSchema } from "./json-schema.js";

export interface Persona {
  $schema: "ghost-invasion/persona@1";
  id: string;
  archetype: string;
  role: { name: string; authStrategy: string; stateRef: string | null };
  device: { preset: string; viewport: { width: number; height: number }; touch: boolean; scaleFactor: number };
  network: { profile: string; downKbps: number; upKbps: number; latencyMs: number };
  patience: { actionTimeoutMs: number; maxWaitBeforeRageMs: number; giveUpAfterSteps: number };
  mistakePattern: Record<string, number | boolean>;
  timing: { thinkTimeMs: [number, number]; typeDelayMs: [number, number] };
  dataState: { inputProfile: string; recordCountBefore: number; fixtureRef: string };
}

export const personaSchema: JsonSchema = {
  $id: "ghost-invasion/persona@1",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "id", "archetype", "role", "device", "network", "patience", "mistakePattern", "timing", "dataState"],
  properties: {
    $schema: { const: "ghost-invasion/persona@1" },
    id: { type: "string" },
    archetype: { type: "string" },
    role: {
      type: "object",
      additionalProperties: false,
      required: ["name", "authStrategy", "stateRef"],
      properties: {
        name: { type: "string" },
        authStrategy: { type: "string" },
        stateRef: { type: ["string", "null"] }
      }
    },
    device: {
      type: "object",
      additionalProperties: false,
      required: ["preset", "viewport", "touch", "scaleFactor"],
      properties: {
        preset: { type: "string" },
        viewport: {
          type: "object",
          additionalProperties: false,
          required: ["width", "height"],
          properties: { width: { type: "integer" }, height: { type: "integer" } }
        },
        touch: { type: "boolean" },
        scaleFactor: { type: "number" }
      }
    },
    network: {
      type: "object",
      additionalProperties: false,
      required: ["profile", "downKbps", "upKbps", "latencyMs"],
      properties: {
        profile: { type: "string" },
        downKbps: { type: "number" },
        upKbps: { type: "number" },
        latencyMs: { type: "number" }
      }
    },
    patience: {
      type: "object",
      additionalProperties: false,
      required: ["actionTimeoutMs", "maxWaitBeforeRageMs", "giveUpAfterSteps"],
      properties: {
        actionTimeoutMs: { type: "number" },
        maxWaitBeforeRageMs: { type: "number" },
        giveUpAfterSteps: { type: "number" }
      }
    },
    mistakePattern: { type: "object", additionalProperties: { type: ["number", "boolean"] } },
    timing: {
      type: "object",
      additionalProperties: false,
      required: ["thinkTimeMs", "typeDelayMs"],
      properties: {
        thinkTimeMs: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
        typeDelayMs: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } }
      }
    },
    dataState: {
      type: "object",
      additionalProperties: false,
      required: ["inputProfile", "recordCountBefore", "fixtureRef"],
      properties: {
        inputProfile: { type: "string" },
        recordCountBefore: { type: "number" },
        fixtureRef: { type: "string" }
      }
    }
  }
};

