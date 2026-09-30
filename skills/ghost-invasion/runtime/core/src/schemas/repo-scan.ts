import type { JsonSchema } from "./json-schema.js";

export interface RepoScan {
  $schema: "ghost-invasion/repo-scan@1";
  schemaVersion: "1.0";
  scannedAt: string;
  rootPath: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  stacks: Array<"next-app" | "next-pages" | "sveltekit" | "express" | "hono" | "vite-react" | "remix" | "nuxt" | "unknown">;
  files: Array<{ path: string; kind: string }>;
  envSignals: Array<{ key: string; provider: string; severity: "block" | "warn" | "info"; last4?: string }>;
  adapters: Array<{ id: string; confidence: number; evidence: string[] }>;
}

export const repoScanSchema: JsonSchema = {
  $id: "ghost-invasion/repo-scan@1",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "schemaVersion", "scannedAt", "rootPath", "packageManager", "stacks", "files", "envSignals", "adapters"],
  properties: {
    $schema: { const: "ghost-invasion/repo-scan@1" },
    schemaVersion: { const: "1.0" },
    scannedAt: { type: "string" },
    rootPath: { type: "string" },
    packageManager: { enum: ["npm", "pnpm", "yarn", "bun", "unknown"] },
    stacks: { type: "array", items: { enum: ["next-app", "next-pages", "sveltekit", "express", "hono", "vite-react", "remix", "nuxt", "unknown"] } },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "kind"],
        properties: { path: { type: "string" }, kind: { type: "string" } }
      }
    },
    envSignals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "provider", "severity"],
        properties: {
          key: { type: "string" },
          provider: { type: "string" },
          severity: { enum: ["block", "warn", "info"] },
          last4: { type: "string" }
        }
      }
    },
    adapters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "confidence", "evidence"],
        properties: {
          id: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};
