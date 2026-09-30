import type { JsonSchema } from "./json-schema.js";
import { findingCategoryEnum, severityEnum } from "./json-schema.js";

export interface Finding {
  $schema: "ghost-invasion/finding@1";
  id: string;
  title: string;
  category: (typeof findingCategoryEnum)[number];
  severity: (typeof severityEnum)[number];
  confidence: number;
  invariant: string;
  affected: { surfaceId: string; route: string; api?: string };
  reproducedAcross: { personas: number; inputProfiles: number; seeds: number };
  occurrences: number;
  pristinePassed: boolean;
  reproductionRate: string;
  mockDependent: boolean;
  signals: string[];
  expected: string;
  actual: string;
  evidence: string[];
  reproSteps: string;
  minimalRepro: string | null;
  suggestedFix: string;
  generatedTest: string;
}

export const findingSchema: JsonSchema = {
  $id: "ghost-invasion/finding@1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "id",
    "title",
    "category",
    "severity",
    "confidence",
    "invariant",
    "affected",
    "reproducedAcross",
    "occurrences",
    "pristinePassed",
    "reproductionRate",
    "mockDependent",
    "signals",
    "expected",
    "actual",
    "evidence",
    "reproSteps",
    "minimalRepro",
    "suggestedFix",
    "generatedTest"
  ],
  properties: {
    $schema: { const: "ghost-invasion/finding@1" },
    id: { type: "string" },
    title: { type: "string" },
    category: { enum: findingCategoryEnum },
    severity: { enum: severityEnum },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    invariant: { type: "string" },
    affected: {
      type: "object",
      additionalProperties: false,
      required: ["surfaceId", "route"],
      properties: {
        surfaceId: { type: "string" },
        route: { type: "string" },
        api: { type: "string" }
      }
    },
    reproducedAcross: {
      type: "object",
      additionalProperties: false,
      required: ["personas", "inputProfiles", "seeds"],
      properties: {
        personas: { type: "integer", minimum: 0 },
        inputProfiles: { type: "integer", minimum: 0 },
        seeds: { type: "integer", minimum: 0 }
      }
    },
    occurrences: { type: "integer", minimum: 0 },
    pristinePassed: { type: "boolean" },
    reproductionRate: { type: "string" },
    mockDependent: { type: "boolean" },
    signals: { type: "array", items: { type: "string" } },
    expected: { type: "string" },
    actual: { type: "string" },
    evidence: { type: "array", minItems: 1, items: { type: "string" } },
    reproSteps: { type: "string" },
    minimalRepro: { type: ["string", "null"] },
    suggestedFix: { type: "string" },
    generatedTest: { type: "string" }
  }
};

