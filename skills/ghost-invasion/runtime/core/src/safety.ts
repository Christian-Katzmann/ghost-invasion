import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EgressCanaryProof } from "./egress.js";
import { defaultEgressAllowlist, runContainerCanaryMatrix } from "./egress.js";
import { chooseMachineAwareConcurrency } from "./memory-sizing.js";
import { stripeBlockedStubService, stripeLocalstripeService } from "./run-modes.js";
import type { SafetyVerdict } from "./schemas/safety-verdict.js";

type TargetRisk = SafetyVerdict["targetRisk"];

export interface EvaluateSafetyOptions {
  cwd?: string;
  baseUrl?: string;
  allowProductionTarget?: boolean;
  approvedPlanHash?: string | null;
  dataIsolation?: string;
  egressProof?: EgressCanaryProof;
  env?: NodeJS.ProcessEnv;
  mode?: string;
  mutating?: boolean;
  resetStrategy?: string;
  runEgressCanary?: boolean;
}

interface EnvSignal {
  key: string;
  provider: string;
  severity: "block" | "mock" | "warn";
  last4?: string;
  reason: string;
}

interface EnvRecord {
  key: string;
  value: string;
  source: string;
}

const riskRank: Record<TargetRisk, number> = { local: 0, staging: 1, prod: 2 };

export function createEmptySafetyVerdict(): SafetyVerdict {
  return {
    $schema: "ghost-invasion/safety-verdict@1",
    schemaVersion: "1.0",
    // Not "allow": an unconfigured target has not been judged safe, it has not been
    // judged at all. Greeting the first-time operator with the green word "allow"
    // is a false-green (S-046). The run-time gate still fails closed elsewhere.
    verdict: "not-configured",
    targetRisk: "local",
    hardStop: false,
    reasons: [],
    liveSecrets: [],
    egress: {
      mode: "attach-only",
      proven: false,
      canaryMatrix: {},
      allowlist: ["localhost", "127.0.0.1"]
    },
    mocksApplied: [],
    dataReset: {
      strategy: "none",
      isolation: "unknown",
      destructiveAllowed: false
    },
    rateLimits: {
      browserConcurrency: 0,
      apiRps: 0,
      memoryAware: false
    },
    flags: {
      allowProductionTarget: false
    },
    approvalRequired: false,
    approvedPlanHash: null,
    explain: "No target has been configured yet. Run init --manual or scan before a real invasion."
  };
}

function maxRisk(...risks: TargetRisk[]): TargetRisk {
  return risks.reduce((highest, risk) => (riskRank[risk] > riskRank[highest] ? risk : highest), "local" as TargetRisk);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower.endsWith(".local") ||
    lower.endsWith(".test") ||
    lower.startsWith("127.") ||
    isPrivateIpv4(lower)
  );
}

function hostRisk(baseUrl: string | undefined): { risk: TargetRisk; reason: string } {
  if (!baseUrl) {
    return { risk: "prod", reason: "target URL missing; fail closed" };
  }

  try {
    const url = new URL(baseUrl);
    if (isLocalHostname(url.hostname)) {
      return { risk: "local", reason: `host=${url.hostname} in local allowlist` };
    }
    if (url.hostname.endsWith(".vercel.app") && url.hostname.includes("-git-")) {
      return { risk: "staging", reason: `host=${url.hostname} looks like a preview URL` };
    }
    return { risk: "prod", reason: `host=${url.hostname} is not local` };
  } catch {
    return { risk: "prod", reason: "target URL is unparseable; fail closed" };
  }
}

function last4(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : undefined;
}

function isLocalDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:", "mongodb:", "mongodb+srv:"].includes(url.protocol)) return true;
    return isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function parseEnvFile(content: string, source: string): EnvRecord[] {
  const records: EnvRecord[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    records.push({ key, value, source });
  }
  return records;
}

async function readEnvFiles(cwd: string): Promise<{ records: EnvRecord[]; unreadable: EnvSignal[] }> {
  const records: EnvRecord[] = [];
  const unreadable: EnvSignal[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(cwd);
  } catch {
    return {
      records,
      unreadable: [{ key: cwd, provider: "env-file", severity: "block", reason: "project directory unreadable" }]
    };
  }

  for (const entry of entries.filter((name) => name === ".env" || name.startsWith(".env."))) {
    const path = join(cwd, entry);
    try {
      records.push(...parseEnvFile(await readFile(path, "utf8"), entry));
    } catch {
      unreadable.push({ key: entry, provider: "env-file", severity: "block", reason: "secret file present but unreadable" });
    }
  }

  return { records, unreadable };
}

function scanEnvRecords(records: EnvRecord[]): EnvSignal[] {
  const signals: EnvSignal[] = [];

  const add = (record: EnvRecord, provider: string, severity: EnvSignal["severity"], reason: string) => {
    signals.push({ key: record.key, provider, severity, last4: last4(record.value), reason });
  };

  for (const record of records) {
    const key = record.key.toUpperCase();
    const value = record.value.trim();
    if (!value) continue;

    if (/^(sk|rk)_live_/.test(value)) add(record, "stripe", "block", "live Stripe key");
    if (/^(AKIA|ASIA)[A-Z0-9]{16}/.test(value)) add(record, "aws", "block", "live AWS access key");
    if (/^(sk|rk)_test_/.test(value)) add(record, "stripe", "mock", "test Stripe key should be mocked");
    if (/^re_[A-Za-z0-9_/-]+/.test(value) || key.includes("RESEND")) add(record, "resend", "mock", "email provider should be sunk to Mailpit");
    if (/^SG\.[A-Za-z0-9_-]+/.test(value) || key.includes("SENDGRID")) add(record, "sendgrid", "mock", "email provider should be sunk to Mailpit");
    if (key.includes("POSTMARK")) add(record, "postmark", "mock", "email provider should be sunk to Mailpit");
    if (key.includes("WEBHOOK_SECRET")) add(record, "webhook", "mock", "webhooks should target the local sink");
    if (key.includes("S3") || key.includes("R2")) add(record, "storage", "mock", "object storage should target the local S3 stub");
    if (key === "NEXTAUTH_SECRET" || key === "AUTH_SECRET") add(record, "auth", "warn", "auth secret present; never expose it to drones");
    if (key === "SUPABASE_SERVICE_ROLE_KEY") add(record, "supabase", "warn", "service role key present; isolate adapter-only use");

    const looksLikeDatabaseUrl =
      key.includes("DATABASE_URL") ||
      key.includes("POSTGRES") ||
      key.includes("MONGO") ||
      /^(postgres|postgresql|mongodb|mongodb\+srv):/.test(value);
    if (looksLikeDatabaseUrl && /^(postgres|postgresql|mongodb|mongodb\+srv):/.test(value) && !isLocalDatabaseUrl(value)) {
      add(record, "database", "block", "database URL points off-box");
    }
  }

  const unique = new Map<string, EnvSignal>();
  for (const signal of signals) {
    const id = `${signal.key}:${signal.provider}:${signal.severity}:${signal.last4 ?? ""}`;
    if (!unique.has(id)) unique.set(id, signal);
  }
  return [...unique.values()];
}

async function collectEnvSignals(cwd: string, env: NodeJS.ProcessEnv): Promise<EnvSignal[]> {
  const { records, unreadable } = await readEnvFiles(cwd);
  const processRecords = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => ({ key, value, source: "process.env" }));
  return [...unreadable, ...scanEnvRecords([...records, ...processRecords])];
}

function secretRisk(signals: EnvSignal[]): TargetRisk {
  return signals.some((signal) => signal.severity === "block") ? "prod" : "local";
}

function renderExplain(verdict: SafetyVerdict, blockers: string[], warnings: string[]): string {
  if (verdict.verdict === "allow") {
    return "Ghost can run this target: local target, egress trap proven, reset/isolation accepted, and rate limits sized to this machine.";
  }

  const lines: string[] = [];
  if (blockers.length > 0) {
    lines.push("Ghost will not run mutating or integration users yet.");
    lines.push(`Why: ${blockers.join("; ")}.`);
    lines.push(
      "Safe options: start Docker Desktop and re-run doctor, point the app at a local/resettable database, remove live keys, or run read-only attach mode."
    );
  } else {
    lines.push("Ghost can run with warnings, but it will keep risky services mocked or isolated.");
  }
  if (warnings.length > 0) {
    lines.push(`Warnings: ${warnings.join("; ")}.`);
  }
  return lines.join(" ");
}

function dataResetVerdict(
  resetStrategy: string,
  isolation: string,
  mutating: boolean,
  targetRisk: TargetRisk
): { dataReset: SafetyVerdict["dataReset"]; blockers: string[]; reasons: string[] } {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const trusted =
    (resetStrategy === "user-command" && isolation === "user-reset") ||
    (resetStrategy === "supabase-db-reset" && isolation === "local-stack") ||
    (resetStrategy === "ephemeral-container" && isolation === "container") ||
    (resetStrategy === "dedicated-schema" && isolation === "dedicated-schema");

  if (trusted) reasons.push(`data reset accepted: ${resetStrategy}/${isolation}`);
  if (mutating && !trusted) blockers.push("no verified reset/isolation boundary for mutating personas");

  const destructiveAllowed = trusted && targetRisk !== "prod";
  if (targetRisk === "prod") reasons.push("production data risk keeps destructive personas off");

  return { dataReset: { strategy: resetStrategy, isolation, destructiveAllowed }, blockers, reasons };
}

export async function evaluateSafety(options: EvaluateSafetyOptions = {}): Promise<SafetyVerdict> {
  if (!options.baseUrl) {
    return createEmptySafetyVerdict();
  }

  const cwd = options.cwd ?? process.cwd();
  const mode = options.mode ?? "quick";
  const mutating = options.mutating ?? true;
  const allowProductionTarget = Boolean(options.allowProductionTarget);
  const env = options.env ?? process.env;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];

  const host = hostRisk(options.baseUrl);
  reasons.push(host.reason);

  const envSignals = await collectEnvSignals(cwd, env);
  const blockingEnv = envSignals.filter((signal) => signal.severity === "block");
  const mockEnv = envSignals.filter((signal) => signal.severity === "mock");
  const warningEnv = envSignals.filter((signal) => signal.severity === "warn");
  if (blockingEnv.length > 0) blockers.push(`dangerous environment detected (${blockingEnv.map((signal) => signal.key).join(", ")})`);
  if (mockEnv.length > 0) warnings.push(`service credentials will be mocked (${mockEnv.map((signal) => signal.key).join(", ")})`);
  if (warningEnv.length > 0) warnings.push(`sensitive adapter-only keys present (${warningEnv.map((signal) => signal.key).join(", ")})`);

  const targetRisk = maxRisk(host.risk, secretRisk(envSignals));
  const hardStop = targetRisk === "prod" && !allowProductionTarget;
  if (hardStop) blockers.push("target risk is production and --allow-production-target was not supplied");

  const egressProof =
    options.egressProof ??
    (options.runEgressCanary === false
      ? {
          mode: "container-firewall" as const,
          proven: false,
          canaryMatrix: { docker: "not-run:disabled" },
          allowlist: [...defaultEgressAllowlist],
          dockerAvailable: false,
          errors: ["egress canary disabled"]
        }
      : await runContainerCanaryMatrix());

  if (egressProof.proven) {
    reasons.push("egress canary matrix: all blocked");
  } else if (mutating) {
    blockers.push(`egress trap is not proven (${egressProof.errors[0] ?? "unknown canary failure"})`);
  } else {
    warnings.push("egress trap is not proven; attach-only read-only mode only");
  }

  const reset = dataResetVerdict(
    options.resetStrategy ?? "none",
    options.dataIsolation ?? "unknown",
    mutating,
    targetRisk
  );
  blockers.push(...reset.blockers);
  reasons.push(...reset.reasons);

  const browserConcurrency = chooseMachineAwareConcurrency();
  if (browserConcurrency === 0) blockers.push("not enough free memory to launch browser contexts safely");
  reasons.push(`machine-aware browser concurrency=${browserConcurrency}`);

  const quickMaySkipApproval =
    mode === "quick" && targetRisk === "local" && blockingEnv.length === 0 && (!mutating || reset.dataReset.isolation !== "unknown");
  const approvalRequired =
    ["deep", "chaos", "payments", "concurrency", "permission"].includes(mode) || targetRisk !== "local" || !quickMaySkipApproval;
  if (approvalRequired && !options.approvedPlanHash) blockers.push("plan approval is required before this run mode");

  const liveSecrets = envSignals.map((signal) => ({
    key: signal.key,
    provider: signal.provider,
    severity: signal.severity,
    ...(signal.last4 ? { last4: signal.last4 } : {})
  }));
  // Honest containment story: Ghost only operates a real local sink for Stripe in
  // payments mode (localstripe). Everything else — flagged service credentials, plus
  // Stripe outside payments mode — is contained by the --network none/--internal trap,
  // not by a Ghost-run mock. We do NOT claim s3-stub/webhook-sink/mailpit sinks: Ghost
  // ships no such servers and (for mailpit) only reads from user-supplied infra (S-010).
  const networkTrapVia = "denied via network trap";
  const mocksApplied = [
    ...mockEnv.map((signal) => ({ service: signal.provider, via: networkTrapVia })),
    mode === "payments"
      ? { service: "stripe", via: stripeLocalstripeService }
      : { service: "stripe", via: stripeBlockedStubService }
  ];

  const verdict: SafetyVerdict = {
    $schema: "ghost-invasion/safety-verdict@1",
    schemaVersion: "1.0",
    verdict: blockers.length > 0 ? "block" : warnings.length > 0 ? "allow-with-warnings" : "allow",
    targetRisk,
    hardStop,
    reasons,
    liveSecrets,
    egress: {
      mode: !mutating && !egressProof.proven ? "attach-only" : egressProof.mode,
      proven: egressProof.proven,
      canaryMatrix: egressProof.canaryMatrix,
      allowlist: egressProof.allowlist
    },
    mocksApplied,
    dataReset: reset.dataReset,
    rateLimits: { browserConcurrency, apiRps: targetRisk === "local" ? 25 : 10, memoryAware: true },
    flags: { allowProductionTarget },
    approvalRequired,
    approvedPlanHash: options.approvedPlanHash ?? null,
    explain: ""
  };
  verdict.explain = renderExplain(verdict, blockers, warnings);
  return verdict;
}
