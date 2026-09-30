export type JsonSchema = Record<string, unknown>;

export const schemaVersionProperty = {
  type: "string",
  pattern: "^ghost-invasion/[a-z-]+@1$"
};

export const severityEnum = ["critical", "high", "medium", "low", "info"] as const;
export const findingCategoryEnum = ["confirmed-bug", "needs-human-review", "suspicious", "flaky", "suppressed"] as const;
export const mutationTierEnum = ["rest", "server-action", "form-post", "browser-only"] as const;

