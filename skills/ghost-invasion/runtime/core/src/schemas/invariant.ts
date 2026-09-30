import type { JsonSchema } from "./json-schema.js";
import { severityEnum } from "./json-schema.js";

export interface Invariant {
  $schema: "ghost-invasion/invariant@1";
  id: string;
  class: "hard" | "soft";
  severity: (typeof severityEnum)[number];
  statement: string;
  evidenceRequired: string[];
  autoAttachWhen: string;
}

export const invariantSchema: JsonSchema = {
  $id: "ghost-invasion/invariant@1",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "id", "class", "severity", "statement", "evidenceRequired", "autoAttachWhen"],
  properties: {
    $schema: { const: "ghost-invasion/invariant@1" },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
    class: { enum: ["hard", "soft"] },
    severity: { enum: severityEnum },
    statement: { type: "string" },
    evidenceRequired: { type: "array", minItems: 1, items: { type: "string" } },
    autoAttachWhen: { type: "string" }
  }
};

