import type { JsonSchema } from "./json-schema.js";
import { mutationTierEnum } from "./json-schema.js";

export interface Surface {
  $schema: "ghost-invasion/surface@1";
  id: string;
  name: string;
  type: "core" | "supporting" | "admin" | "auth";
  stack: string;
  routes: Array<{ path: string; params: string[]; dynamic: boolean }>;
  methods: string[];
  kind: "page" | "mutation" | "api" | "server-action" | "form-post" | "resource-route" | "nav";
  mutationTier: "rest" | "server-action" | "form-post" | "browser-only";
  requiresAuth: boolean;
  requiresRole: string[];
  isDestructive: boolean;
  integrations: string[];
  inputs: Array<{ name: string; type: string; required: boolean; source: string }>;
  risk: "critical" | "high" | "medium" | "low";
  confidence: Record<string, number>;
  evidence: Array<{ signal: string; ref: string; reliable: boolean }>;
}

export const surfaceSchema: JsonSchema = {
  $id: "ghost-invasion/surface@1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "id",
    "name",
    "type",
    "stack",
    "routes",
    "methods",
    "kind",
    "mutationTier",
    "requiresAuth",
    "requiresRole",
    "isDestructive",
    "integrations",
    "inputs",
    "risk",
    "confidence",
    "evidence"
  ],
  properties: {
    $schema: { const: "ghost-invasion/surface@1" },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
    name: { type: "string" },
    type: { enum: ["core", "supporting", "admin", "auth"] },
    stack: { type: "string" },
    routes: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "params", "dynamic"],
        properties: {
          path: { type: "string" },
          params: { type: "array", items: { type: "string" } },
          dynamic: { type: "boolean" }
        }
      }
    },
    methods: { type: "array", items: { type: "string" } },
    kind: { enum: ["page", "mutation", "api", "server-action", "form-post", "resource-route", "nav"] },
    mutationTier: { enum: mutationTierEnum },
    requiresAuth: { type: "boolean" },
    requiresRole: { type: "array", items: { type: "string" } },
    isDestructive: { type: "boolean" },
    integrations: { type: "array", items: { type: "string" } },
    inputs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "required", "source"],
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          required: { type: "boolean" },
          source: { type: "string" }
        }
      }
    },
    risk: { enum: ["critical", "high", "medium", "low"] },
    confidence: { type: "object", additionalProperties: { type: "number", minimum: 0, maximum: 1 } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["signal", "ref", "reliable"],
        properties: {
          signal: { type: "string" },
          ref: { type: "string" },
          reliable: { type: "boolean" }
        }
      }
    }
  }
};

