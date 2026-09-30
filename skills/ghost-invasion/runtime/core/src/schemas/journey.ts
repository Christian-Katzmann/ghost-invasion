import type { JsonSchema } from "./json-schema.js";

export type JourneyStepType =
  | "goto"
  | "clickRole"
  | "clickText"
  | "fill"
  | "selectOption"
  | "upload"
  | "expectVisible"
  | "expectHidden"
  | "expectUrl"
  | "expectText"
  | "expectDbRow"
  | "expectDbDiff"
  | "dbSnapshot"
  | "apiCall"
  | "wait"
  | "refresh"
  | "back"
  | "doubleSubmit"
  | "newTab"
  | "screenshot";

export interface Journey {
  $schema: "ghost-invasion/journey@1";
  id: string;
  name: string;
  goal: string;
  appliesToPersonas: string[];
  invariantsTested: string[];
  pristineRequired: boolean;
  anchors: { routes: string[]; mutations: string[]; surfaceHash: string };
  idealPath: string[];
  steps: Array<{ type: JourneyStepType; [key: string]: unknown }>;
  success: Array<{ type: JourneyStepType; [key: string]: unknown }>;
  abandon: Array<{ type: JourneyStepType; [key: string]: unknown }>;
}

const primitiveEnum = [
  "goto",
  "clickRole",
  "clickText",
  "fill",
  "selectOption",
  "upload",
  "expectVisible",
  "expectHidden",
  "expectUrl",
  "expectText",
  "expectDbRow",
  "expectDbDiff",
  "dbSnapshot",
  "apiCall",
  "wait",
  "refresh",
  "back",
  "doubleSubmit",
  "newTab",
  "screenshot"
];

const primitiveObject = {
  type: "object",
  required: ["type"],
  properties: { type: { enum: primitiveEnum } },
  additionalProperties: true
};

export const journeySchema: JsonSchema = {
  $id: "ghost-invasion/journey@1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "id",
    "name",
    "goal",
    "appliesToPersonas",
    "invariantsTested",
    "pristineRequired",
    "anchors",
    "idealPath",
    "steps",
    "success",
    "abandon"
  ],
  properties: {
    $schema: { const: "ghost-invasion/journey@1" },
    id: { type: "string" },
    name: { type: "string" },
    goal: { type: "string" },
    appliesToPersonas: { type: "array", minItems: 1, items: { type: "string" } },
    invariantsTested: { type: "array", minItems: 1, items: { type: "string" } },
    pristineRequired: { type: "boolean" },
    anchors: {
      type: "object",
      additionalProperties: false,
      required: ["routes", "mutations", "surfaceHash"],
      properties: {
        routes: { type: "array", items: { type: "string" } },
        mutations: { type: "array", items: { type: "string" } },
        surfaceHash: { type: "string" }
      }
    },
    idealPath: { type: "array", items: { type: "string" } },
    steps: { type: "array", minItems: 1, items: primitiveObject },
    success: { type: "array", minItems: 1, items: primitiveObject },
    abandon: { type: "array", items: primitiveObject }
  }
};

