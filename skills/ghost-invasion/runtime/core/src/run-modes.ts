import type { GhostInvasionPlan } from "./schemas/ghost-plan.js";
import type { Journey } from "./schemas/journey.js";
import type { Persona } from "./schemas/persona.js";

export type RunMode =
  | "quick"
  | "deep"
  | "mobile"
  | "auth"
  | "payments"
  | "admin"
  | "concurrency"
  | "chaos"
  | "permission"
  | "ux"
  | "performance"
  | "fix-critical";

export type RunModeFlags = Partial<Record<RunMode, boolean>>;

export const stripeBlockedStubService = "stripe:blocked-stub";
export const stripeLocalstripeService = "stripe:localstripe";

const orderedModes: RunMode[] = [
  "quick",
  "deep",
  "mobile",
  "auth",
  "payments",
  "admin",
  "concurrency",
  "chaos",
  "permission",
  "ux",
  "performance",
  "fix-critical"
];

const tenantPersonaIds = ["permission-boundary-user", "tenant-a-user", "tenant-b-user"] as const;

export function selectRunMode(flags: RunModeFlags, fallback: string | undefined = "quick"): RunMode {
  const selected = orderedModes.filter((mode) => Boolean(flags[mode]));
  if (selected.length > 1) {
    throw new Error(`Choose one run mode, not ${selected.map((mode) => `--${mode}`).join(", ")}.`);
  }
  if (selected[0]) return selected[0];
  return normalizeRunMode(fallback);
}

// Every run mode — quick included — passes the same fail-closed run gate (egress trap,
// local-target check, approval-hash binding). Elevated modes differ only in that they can
// never skip plan approval; quick may skip it on a local target with a trusted reset.
export const elevatedRunModes: RunMode[] = ["deep", "auth", "payments", "admin", "permission", "fix-critical"];

// One-line, human-readable echo of which run mode a `run` invocation resolved to, so the
// operator can see the precedence decision instead of inferring it from behaviour (S-052).
export function formatRunModeEcho(flags: RunModeFlags): string {
  const explicit = orderedModes.some((mode) => Boolean(flags[mode]));
  if (!explicit) return "Run mode: quick (plan default)";
  return `Run mode: ${selectRunMode(flags)}`;
}

// Help text appended under `run --help` so the mode flags read as one group with an
// explicit resolution rule and the elevated-mode approval requirement (S-052).
export const runModeHelpText = [
  "Run modes (pick exactly one; the flags below are a group, not additive):",
  "  --quick (default)  --deep  --mobile  --auth  --payments  --admin",
  "  --concurrency  --chaos  --permission  --ux  --performance  --fix-critical",
  "",
  "Resolution: with no mode flag, the plan's own mode is used (quick by default).",
  "Pass exactly one mode flag; passing two or more fails fast with a one-line error.",
  "Every mode passes the same fail-closed run gate (`ghost-invasion doctor` previews it).",
  `Elevated modes (${elevatedRunModes.map((mode) => `--${mode}`).join(", ")}) additionally always`,
  "require an approved plan; quick may skip approval only on a local target with a trusted reset."
].join("\n");

export function normalizeRunMode(input: string | undefined): RunMode {
  const normalized = String(input ?? "quick").trim().replace(/^--/, "");
  if (orderedModes.includes(normalized as RunMode)) return normalized as RunMode;
  return "quick";
}

export function preparePlanForRunMode(plan: GhostInvasionPlan, mode: RunMode): GhostInvasionPlan {
  let prepared: GhostInvasionPlan = { ...plan, mode };
  if (mode === "payments") {
    prepared = withStripeService(prepared, stripeLocalstripeService);
    prepared = focusPaymentPlan(prepared);
  } else {
    prepared = withStripeService(prepared, stripeBlockedStubService);
  }
  if (isTenantIsolationDeepMode(prepared, mode)) {
    prepared = expandTenantIsolationPlan(prepared);
  }
  return prepared;
}

export function isPaymentJourney(journey: Journey): boolean {
  return /\b(checkout|payment|stripe|billing|subscription|invoice|card|cart)\b/.test(journeySearchText(journey));
}

export function paymentJourneys(plan: GhostInvasionPlan): Journey[] {
  return plan.journeys.filter(isPaymentJourney);
}

export function isTenantIsolationDeepMode(plan: GhostInvasionPlan, mode: RunMode): boolean {
  return mode === "permission" || plan.pack === "tenant-isolation";
}

export function isTenantIsolationJourney(journey: Journey): boolean {
  return (
    journey.invariantsTested.includes("auth.no-cross-tenant-read") ||
    /\b(tenant|permission|owner|cross-account|cross-tenant|other-user)\b/.test(journeySearchText(journey))
  );
}

function withStripeService(plan: GhostInvasionPlan, service: string): GhostInvasionPlan {
  const mocksApplied = plan.safety.mocksApplied.filter((entry) => !/^stripe(?::|$)/.test(entry));
  return {
    ...plan,
    safety: {
      ...plan.safety,
      mocksApplied: [...mocksApplied, service]
    }
  };
}

function focusPaymentPlan(plan: GhostInvasionPlan): GhostInvasionPlan {
  const journeys = paymentJourneys(plan);
  if (journeys.length === 0) return { ...plan, journeys: [] };
  const sessions = Math.max(plan.swarm.totalBrowserSessions || 0, journeys.length);
  return {
    ...plan,
    journeys,
    swarm: {
      ...plan.swarm,
      totalBrowserSessions: sessions,
      browserWaves: Math.max(1, Math.ceil(sessions / Math.max(1, plan.swarm.browserConcurrency || 1)))
    }
  };
}

function expandTenantIsolationPlan(plan: GhostInvasionPlan): GhostInvasionPlan {
  const personas = ensureTenantPersonas(plan.personas);
  const tenantJourneys = ensureTenantJourneys(plan.journeys).map((journey) =>
    isTenantIsolationJourney(journey)
      ? {
          ...journey,
          appliesToPersonas: mergeStrings(journey.appliesToPersonas, [...tenantPersonaIds]),
          invariantsTested: mergeStrings(journey.invariantsTested, ["auth.no-cross-tenant-read"])
        }
      : journey
  );
  const focusedJourneys = tenantJourneys.filter(isTenantIsolationJourney);
  const selectedJourneys = focusedJourneys.length > 0 ? focusedJourneys : tenantJourneys;
  const tenantSessions = selectedJourneys.reduce((total, journey) => total + personasForJourney(personas, journey).length, 0);

  return {
    ...plan,
    pack: "tenant-isolation",
    personas,
    journeys: selectedJourneys,
    swarm: {
      ...plan.swarm,
      browserConcurrency: Math.max(1, Math.min(plan.swarm.browserConcurrency || 1, Math.max(1, tenantSessions))),
      browserWaves: Math.max(1, Math.ceil(Math.max(1, tenantSessions) / Math.max(1, plan.swarm.browserConcurrency || 1))),
      totalBrowserSessions: Math.max(plan.swarm.totalBrowserSessions || 0, tenantSessions)
    }
  };
}

function ensureTenantPersonas(personas: Persona[]): Persona[] {
  const base = personas.find((persona) => persona.id === "permission-boundary-user") ?? personas[0];
  if (!base) return personas;
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  for (const id of tenantPersonaIds) {
    if (byId.has(id)) continue;
    byId.set(id, {
      ...base,
      id,
      archetype: id === "permission-boundary-user" ? "permission_boundary_user" : "tenant_user",
      role: {
        name: id.replace(/-user$/, ""),
        authStrategy: base.role.authStrategy,
        stateRef: `${id}.storageState.json`
      },
      dataState: {
        ...base.dataState,
        inputProfile: id,
        fixtureRef: "projectly-tenants"
      }
    });
  }
  return [...byId.values()];
}

function ensureTenantJourneys(journeys: Journey[]): Journey[] {
  const byId = new Map(journeys.map((journey) => [journey.id, journey]));
  for (const journey of bundledTenantJourneys()) {
    if (!byId.has(journey.id)) byId.set(journey.id, journey);
  }
  return [...byId.values()];
}

function bundledTenantJourneys(): Journey[] {
  const base = {
    $schema: "ghost-invasion/journey@1" as const,
    invariantsTested: ["auth.no-cross-tenant-read"],
    appliesToPersonas: [...tenantPersonaIds],
    pristineRequired: false,
    abandon: []
  };

  return [
    {
      ...base,
      id: "cross-tenant-project-read",
      name: "Cross-tenant project read is blocked",
      goal: "A user must not read another tenant's private project.",
      anchors: {
        routes: ["/projects/project-user-b-private"],
        mutations: ["GET /projects/project-user-b-private"],
        surfaceHash: "sha256:tenant-isolation"
      },
      idealPath: ["apiCall:GET:/projects/project-user-b-private:expect404"],
      steps: [
        {
          type: "apiCall",
          method: "GET",
          url: "/projects/project-user-b-private",
          expectStatus: 404,
          captureResponseBody: true,
          ownerCheck: { expectedOwnerId: "user-a", actualOwnerId: "user-b" }
        }
      ],
      success: [{ type: "wait", ms: 0 }]
    },
    {
      ...base,
      id: "direct-object-url-cross-tenant",
      name: "Direct object URL cross-tenant read is blocked",
      goal: "A direct object URL must not bypass tenant ownership checks.",
      anchors: {
        routes: ["/projects/project-user-b-private?via=direct-object"],
        mutations: ["GET /projects/project-user-b-private"],
        surfaceHash: "sha256:tenant-isolation"
      },
      idealPath: ["apiCall:GET:/projects/project-user-b-private?via=direct-object:expect404"],
      steps: [
        {
          type: "apiCall",
          method: "GET",
          url: "/projects/project-user-b-private?via=direct-object",
          expectStatus: 404,
          captureResponseBody: true,
          ownerCheck: { expectedOwnerId: "user-a", actualOwnerId: "user-b" }
        }
      ],
      success: [{ type: "wait", ms: 0 }]
    },
    {
      ...base,
      id: "cross-account-api-read",
      name: "Cross-account API read is blocked",
      goal: "Account-scoped APIs must reject another tenant's object id.",
      anchors: {
        routes: ["/api/projects/project-user-b-private"],
        mutations: ["GET /api/projects/project-user-b-private"],
        surfaceHash: "sha256:tenant-isolation"
      },
      idealPath: ["apiCall:GET:/api/projects/project-user-b-private:expect404"],
      steps: [
        {
          type: "apiCall",
          method: "GET",
          url: "/api/projects/project-user-b-private",
          expectStatus: 404,
          captureResponseBody: true,
          ownerCheck: { expectedOwnerId: "user-a", actualOwnerId: "user-b" }
        }
      ],
      success: [{ type: "wait", ms: 0 }]
    },
    {
      ...base,
      id: "cross-tenant-project-write",
      name: "Cross-tenant project write is blocked",
      goal: "A user must not update another tenant's private project.",
      anchors: {
        routes: ["/api/projects/project-user-b-private"],
        mutations: ["PATCH /api/projects/project-user-b-private"],
        surfaceHash: "sha256:tenant-isolation"
      },
      idealPath: ["apiCall:PATCH:/api/projects/project-user-b-private:expect403"],
      steps: [
        {
          type: "apiCall",
          method: "PATCH",
          url: "/api/projects/project-user-b-private",
          expectStatus: 403,
          body: { name: "Ghost should not be able to write this" },
          captureResponseBody: true,
          ownerCheck: { expectedOwnerId: "user-a", actualOwnerId: "user-b" }
        }
      ],
      success: [{ type: "wait", ms: 0 }]
    }
  ];
}

function personasForJourney(personas: Persona[], journey: Journey): Persona[] {
  const selected = personas.filter((persona) => journey.appliesToPersonas.includes(persona.id));
  return selected.length > 0 ? selected : personas;
}

function mergeStrings(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])];
}

function journeySearchText(journey: Journey): string {
  return [
    journey.id,
    journey.name,
    journey.goal,
    ...journey.anchors.routes,
    ...journey.anchors.mutations,
    ...journey.idealPath,
    ...journey.invariantsTested
  ]
    .join(" ")
    .toLowerCase();
}
