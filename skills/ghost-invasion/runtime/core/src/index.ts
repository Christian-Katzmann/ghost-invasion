// ---------------------------------------------------------------------------
// Public API for @ghost-invasion/core.
//
// This is the deliberate, semver-bound surface — only the pieces an external
// consumer legitimately needs. The CLI is the primary entry point (the
// `ghost-invasion` bin); this module exposes the programmatic spine around it:
//
//   • Safety   — the canonical pre-run verdict (evaluateSafety / SafetyVerdict).
//   • Evidence — the run event bus and identifiers consumers read.
//   • Schemas  — the JSON-schema contracts + types for every artifact written.
//
// Runner/drone internals (swarm, discovery, classifier, reporter, dashboard,
// adapters, planner, cost-model, …) are intentionally NOT re-exported here: they
// change freely and are not part of the stable contract. Import them from their
// module path (e.g. "@ghost-invasion/core/dist/swarm.js") only if you accept
// that risk.
// ---------------------------------------------------------------------------

// Safety spine — the block-before-spawn verdict.
export { evaluateSafety, createEmptySafetyVerdict } from "./safety.js";
export type { EvaluateSafetyOptions } from "./safety.js";

// Evidence — the append-only run event bus and its identifiers.
export { EvidenceBus, createRunId, failureFingerprint, sanitizePathSegment } from "./evidence.js";
export type { EvidenceEvent, TraceReservation, EvidenceBusOptions, EvidenceBusSummary } from "./evidence.js";

// Schema contracts — types + validators for every artifact Ghost Invasion
// produces. schemas/index.js is itself the curated schema surface (including
// SafetyVerdict and the `versionedSchemas` registry).
export * from "./schemas/index.js";
