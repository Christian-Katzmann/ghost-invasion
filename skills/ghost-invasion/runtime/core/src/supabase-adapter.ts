import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isLoopbackIpv4 } from "./local-host.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<CommandResult>;

export interface SupabaseAdapterOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runCommand?: CommandRunner;
  statusTimeoutMs?: number;
}

export interface SupabaseLocalConfig {
  projectRoot: string;
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  dbUrl: string;
  mailpitUrl: string;
  jwtSecret?: string;
}

export interface SupabaseUserSpec {
  role: string;
  email: string;
  id?: string;
  password?: string;
  appMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
}

export interface ProvisionedSupabaseUser {
  role: string;
  email: string;
  id: string;
}

export interface MintSessionInput {
  role: string;
  email: string;
  appBaseUrl: string;
  storageStatePath: string;
  method?: "otp-token-hash" | "service-role-jwt";
  timeoutMs?: number;
  pollIntervalMs?: number;
  userId?: string;
  ttlSeconds?: number;
}

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  user: {
    id: string;
    email?: string;
    role?: string;
    app_metadata?: Record<string, unknown>;
    user_metadata?: Record<string, unknown>;
  };
}

export interface MintedSupabaseSession {
  role: string;
  email: string;
  storageStatePath: string;
  storageKey: string;
  appOrigin: string;
  method: "otp-token-hash" | "service-role-jwt";
  session: SupabaseSession;
}

export interface SupabaseIsolationVerdict {
  ok: boolean;
  strategy: "supabase-db-reset";
  isolation: "local-stack" | "unknown";
  destructiveAllowed: boolean;
  reasons: string[];
  resetCommand: "supabase db reset --local";
}

export interface SupabaseSeedTable {
  name: string;
  primaryKey?: string;
  cascadeSafe: true;
  scope: Record<string, string | number | boolean>;
  rows: Array<Record<string, unknown>>;
}

export interface SupabaseSeedPlan {
  runId: string;
  approvedTables: string[];
  tables: SupabaseSeedTable[];
}

export interface SupabaseSeedReceipt {
  runId: string;
  inserted: Array<{ table: string; ids: string[]; count: number }>;
}

export interface SupabaseTableSnapshot {
  table: string;
  primaryKey: string;
  scope: Record<string, string | number | boolean>;
  checksum: string;
  count: number;
  rows: Array<Record<string, unknown>>;
}

export interface SupabaseSeedSnapshot {
  runId: string;
  takenAt: string;
  tables: SupabaseTableSnapshot[];
}

export interface SupabaseTableDiff {
  table: string;
  inserted: number;
  removed: number;
  changed: number;
  beforeChecksum: string;
  afterChecksum: string;
  pass: boolean;
}

export interface SupabaseSeedDiff {
  runId: string;
  pass: boolean;
  tables: SupabaseTableDiff[];
}

export class SupabaseAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SupabaseAdapterError";
  }
}

function defaultRunCommand(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: `${stderr}\ncommand timed out after ${options.timeoutMs}ms`.trim() });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-100_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-100_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function fetchFor(options: SupabaseAdapterOptions): typeof fetch {
  return options.fetchImpl ?? fetch;
}

function commandFor(options: SupabaseAdapterOptions): CommandRunner {
  return options.runCommand ?? defaultRunCommand;
}

function projectRootFor(options: SupabaseAdapterOptions): string {
  return options.projectRoot ?? process.cwd();
}

function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "::1" || isLoopbackIpv4(lower);
}

function requireLocalUrl(value: string, label: string): void {
  const url = new URL(value);
  if (!isLocalHostname(url.hostname)) {
    throw new SupabaseAdapterError("supabase-not-local", `${label} must point at localhost or 127.0.0.1, got ${url.hostname}`);
  }
}

function requireLocalDbUrl(value: string): void {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !isLocalHostname(url.hostname)) {
    throw new SupabaseAdapterError("supabase-db-not-local", `Supabase DB URL must be a local Postgres URL, got ${url.protocol}//${url.hostname}`);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonObject(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new SupabaseAdapterError("supabase-status-unparseable", "supabase status -o json did not return JSON");
  }
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
}

function flattenStatus(value: unknown, prefix = ""): Array<{ key: string; value: string }> {
  if (typeof value === "string") return [{ key: prefix, value }];
  if (!value || typeof value !== "object") return [];
  const flattened: Array<{ key: string; value: string }> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flattened.push(...flattenStatus(child, prefix ? `${prefix}.${key}` : key));
  }
  return flattened;
}

function statusValue(status: Record<string, unknown>, matcher: (key: string, value: string) => boolean): string | undefined {
  for (const entry of flattenStatus(status)) {
    const normalizedKey = entry.key.toLowerCase().replace(/[\s_-]+/g, ".");
    if (matcher(normalizedKey, entry.value)) return entry.value;
  }
  return undefined;
}

async function readSupabaseStatus(options: SupabaseAdapterOptions): Promise<Record<string, unknown> | null> {
  const result = await commandFor(options)("supabase", ["status", "-o", "json"], {
    cwd: projectRootFor(options),
    timeoutMs: options.statusTimeoutMs ?? 5000
  });
  if (result.code !== 0) return null;
  return parseJsonObject(result.stdout);
}

export async function resolveSupabaseLocalConfig(options: SupabaseAdapterOptions = {}): Promise<SupabaseLocalConfig> {
  const env = options.env ?? process.env;
  const status = await readSupabaseStatus(options).catch(() => null);
  const fromStatus = (matcher: (key: string, value: string) => boolean): string | undefined =>
    status ? statusValue(status, matcher) : undefined;

  const supabaseUrl =
    env.SUPABASE_URL ??
    env.NEXT_PUBLIC_SUPABASE_URL ??
    fromStatus((key) => key.includes("api") && key.includes("url")) ??
    "http://127.0.0.1:54321";
  const anonKey =
    env.SUPABASE_ANON_KEY ??
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    fromStatus((key) => key.includes("anon") && key.includes("key"));
  const serviceRoleKey =
    env.SUPABASE_SERVICE_ROLE_KEY ??
    fromStatus((key) => (key.includes("service.role") || key.includes("service_role")) && key.includes("key"));
  const dbUrl =
    env.SUPABASE_DB_URL ??
    env.SUPABASE_DATABASE_URL ??
    fromStatus((key, value) => key.includes("db") && key.includes("url") && /^postgres(ql)?:/.test(value));
  const mailpitUrl =
    env.SUPABASE_MAILPIT_URL ??
    env.SUPABASE_INBUCKET_URL ??
    fromStatus((key) => (key.includes("mailpit") || key.includes("inbucket")) && key.includes("url")) ??
    "http://127.0.0.1:54324";
  const jwtSecret = env.SUPABASE_JWT_SECRET ?? fromStatus((key) => key.includes("jwt") && key.includes("secret"));

  const missing = [
    anonKey ? null : "SUPABASE_ANON_KEY",
    serviceRoleKey ? null : "SUPABASE_SERVICE_ROLE_KEY",
    dbUrl ? null : "SUPABASE_DB_URL"
  ].filter((item): item is string => Boolean(item));
  if (missing.length > 0) {
    throw new SupabaseAdapterError(
      "supabase-config-missing",
      `Supabase local config is missing ${missing.join(", ")}. Start the local stack with supabase start or provide local env values.`
    );
  }
  const resolvedAnonKey = anonKey;
  const resolvedServiceRoleKey = serviceRoleKey;
  const resolvedDbUrl = dbUrl;
  if (!resolvedAnonKey || !resolvedServiceRoleKey || !resolvedDbUrl) {
    throw new SupabaseAdapterError("supabase-config-missing", "Supabase local config is incomplete.");
  }

  const config: SupabaseLocalConfig = {
    projectRoot: projectRootFor(options),
    supabaseUrl: normalizeUrl(supabaseUrl),
    anonKey: resolvedAnonKey,
    serviceRoleKey: resolvedServiceRoleKey,
    dbUrl: resolvedDbUrl,
    mailpitUrl: normalizeUrl(mailpitUrl),
    ...(jwtSecret ? { jwtSecret } : {})
  };
  requireLocalUrl(config.supabaseUrl, "Supabase API URL");
  requireLocalUrl(config.mailpitUrl, "Mailpit URL");
  requireLocalDbUrl(config.dbUrl);
  return config;
}

function serviceHeaders(config: SupabaseLocalConfig): HeadersInit {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    "Content-Type": "application/json"
  };
}

function anonHeaders(config: SupabaseLocalConfig): HeadersInit {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`,
    "Content-Type": "application/json"
  };
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit, label: string): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body ? String((body as { message: unknown }).message) : text;
    throw new SupabaseAdapterError("supabase-request-failed", `${label} failed (${response.status}): ${message}`);
  }
  return body as T;
}

function storageKeyForSupabaseUrl(supabaseUrl: string): string {
  const host = new URL(supabaseUrl).hostname;
  const projectRef = host.endsWith(".supabase.co") ? host.split(".")[0] : host.split(".")[0];
  return `sb-${projectRef}-auth-token`;
}

function appOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

async function writeStorageState(path: string, origin: string, storageKey: string, session: SupabaseSession): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        cookies: [],
        origins: [
          {
            origin,
            localStorage: [{ name: storageKey, value: JSON.stringify(session) }]
          }
        ]
      },
      null,
      2
    )}\n`
  );
}

function normalizeSession(body: unknown, fallbackEmail: string): SupabaseSession {
  const maybe = body && typeof body === "object" && "session" in body ? (body as { session: unknown }).session : body;
  if (!maybe || typeof maybe !== "object") {
    throw new SupabaseAdapterError("supabase-session-missing", "Supabase verifyOtp did not return a session");
  }
  const session = maybe as Partial<SupabaseSession>;
  if (!session.access_token || !session.refresh_token) {
    throw new SupabaseAdapterError("supabase-session-missing", "Supabase session is missing access or refresh token");
  }
  const expiresIn = Number(session.expires_in ?? 3600);
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    token_type: session.token_type ?? "bearer",
    expires_in: expiresIn,
    expires_at: Number(session.expires_at ?? Math.floor(Date.now() / 1000) + expiresIn),
    user: session.user ?? { id: "", email: fallbackEmail }
  };
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function directJwtSession(input: { jwtSecret: string; email: string; userId: string; ttlSeconds: number }): SupabaseSession {
  const now = Math.floor(Date.now() / 1000);
  const appMetadata = { provider: "email", providers: ["email"] };
  const userMetadata: Record<string, unknown> = {};
  const accessToken = signJwt(
    {
      aud: "authenticated",
      exp: now + input.ttlSeconds,
      iat: now,
      sub: input.userId,
      email: input.email,
      phone: "",
      app_metadata: appMetadata,
      user_metadata: userMetadata,
      role: "authenticated",
      aal: "aal1",
      session_id: randomUUID()
    },
    input.jwtSecret
  );

  return {
    access_token: accessToken,
    refresh_token: `ghost-local-${randomUUID()}`,
    token_type: "bearer",
    expires_in: input.ttlSeconds,
    expires_at: now + input.ttlSeconds,
    user: {
      id: input.userId,
      email: input.email,
      role: "authenticated",
      app_metadata: appMetadata,
      user_metadata: userMetadata
    }
  };
}

function stringsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsFromUnknown(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const lower = key.toLowerCase();
    if (["text", "html", "body", "snippet", "subject", "content"].some((name) => lower.includes(name))) {
      return stringsFromUnknown(child);
    }
    return stringsFromUnknown(child);
  });
}

export function extractSupabaseOtp(text: string): { tokenHash?: string; token?: string } {
  const tokenHash = /[?&]token_hash=([^&"'<>\s]+)/i.exec(text)?.[1];
  const token = /(?:token|code)[^\d]{0,20}(\d{6})/i.exec(text)?.[1] ?? /\b(\d{6})\b/.exec(text)?.[1];
  return {
    ...(tokenHash ? { tokenHash: decodeURIComponent(tokenHash) } : {}),
    ...(token ? { token } : {})
  };
}

async function fetchJsonOrNull(fetchImpl: typeof fetch, url: string): Promise<unknown | null> {
  const response = await fetchImpl(url);
  if (!response.ok) return null;
  const text = await response.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

function messageId(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  for (const key of ["ID", "Id", "id", "MessageID", "messageId"]) {
    if (typeof record[key] === "string" || typeof record[key] === "number") return String(record[key]);
  }
  return null;
}

function messageList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["messages", "Messages", "items", "Items"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

async function findOtpInMailpit(fetchImpl: typeof fetch, config: SupabaseLocalConfig, email: string): Promise<{ tokenHash?: string; token?: string } | null> {
  const mailpitMessages = await fetchJsonOrNull(fetchImpl, `${config.mailpitUrl}/api/v1/messages?limit=50`).catch(() => null);
  const candidates = messageList(mailpitMessages);
  for (const candidate of candidates) {
    const id = messageId(candidate);
    const detail = id ? await fetchJsonOrNull(fetchImpl, `${config.mailpitUrl}/api/v1/message/${encodeURIComponent(id)}`).catch(() => candidate) : candidate;
    const text = stringsFromUnknown(detail).join("\n");
    if (email && !text.toLowerCase().includes(email.toLowerCase())) continue;
    const otp = extractSupabaseOtp(text);
    if (otp.tokenHash || otp.token) return otp;
  }

  const mailbox = encodeURIComponent(email.split("@")[0] ?? email);
  const inbucketMessages = await fetchJsonOrNull(fetchImpl, `${config.mailpitUrl}/api/v1/mailbox/${mailbox}`).catch(() => null);
  for (const candidate of messageList(inbucketMessages)) {
    const id = messageId(candidate);
    const detail = id ? await fetchJsonOrNull(fetchImpl, `${config.mailpitUrl}/api/v1/mailbox/${mailbox}/${encodeURIComponent(id)}`).catch(() => candidate) : candidate;
    const otp = extractSupabaseOtp(stringsFromUnknown(detail).join("\n"));
    if (otp.tokenHash || otp.token) return otp;
  }

  return null;
}

async function pollForOtp(fetchImpl: typeof fetch, config: SupabaseLocalConfig, email: string, timeoutMs: number, pollIntervalMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const otp = await findOtpInMailpit(fetchImpl, config, email);
    if (otp) return otp;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new SupabaseAdapterError("supabase-otp-timeout", `No Supabase OTP/token_hash email appeared in Mailpit for ${email}`);
}

export class SupabaseAuthAdapter {
  readonly id = "supabase" as const;

  constructor(private readonly options: SupabaseAdapterOptions = {}) {}

  async provisionUsers(users: SupabaseUserSpec[]): Promise<ProvisionedSupabaseUser[]> {
    const config = await resolveSupabaseLocalConfig(this.options);
    const fetchImpl = fetchFor(this.options);
    const provisioned: ProvisionedSupabaseUser[] = [];

    for (const user of users) {
      const body = await requestJson<{ user?: { id?: string; email?: string }; id?: string; email?: string }>(
        fetchImpl,
        `${config.supabaseUrl}/auth/v1/admin/users`,
        {
          method: "POST",
          headers: serviceHeaders(config),
          body: JSON.stringify({
            ...(user.id ? { id: user.id } : {}),
            email: user.email,
            ...(user.password ? { password: user.password } : {}),
            email_confirm: true,
            app_metadata: { role: user.role, ...(user.appMetadata ?? {}) },
            user_metadata: user.userMetadata ?? {}
          })
        },
        `provision Supabase user ${user.email}`
      );
      const id = body.user?.id ?? body.id;
      if (!id) throw new SupabaseAdapterError("supabase-user-id-missing", `Supabase did not return an id for ${user.email}`);
      provisioned.push({ role: user.role, email: body.user?.email ?? body.email ?? user.email, id });
    }

    return provisioned;
  }

  async mintSession(input: MintSessionInput): Promise<MintedSupabaseSession> {
    const config = await resolveSupabaseLocalConfig(this.options);
    const fetchImpl = fetchFor(this.options);
    const method = input.method ?? "otp-token-hash";
    let session: SupabaseSession;

    if (method === "service-role-jwt") {
      if (!config.jwtSecret) {
        throw new SupabaseAdapterError("supabase-jwt-secret-missing", "service-role-jwt minting requires SUPABASE_JWT_SECRET from the local stack");
      }
      session = directJwtSession({
        jwtSecret: config.jwtSecret,
        email: input.email,
        userId: input.userId ?? randomUUID(),
        ttlSeconds: input.ttlSeconds ?? 3600
      });
    } else {
      await requestJson<unknown>(
        fetchImpl,
        `${config.supabaseUrl}/auth/v1/otp`,
        {
          method: "POST",
          headers: anonHeaders(config),
          body: JSON.stringify({ email: input.email, create_user: false })
        },
        `request Supabase OTP for ${input.email}`
      );
      const otp = await pollForOtp(fetchImpl, config, input.email, input.timeoutMs ?? 30_000, input.pollIntervalMs ?? 500);
      const verifyBody = otp.tokenHash
        ? { type: "email", token_hash: otp.tokenHash }
        : { type: "email", email: input.email, token: otp.token };
      session = normalizeSession(
        await requestJson<unknown>(
          fetchImpl,
          `${config.supabaseUrl}/auth/v1/verify`,
          {
            method: "POST",
            headers: anonHeaders(config),
            body: JSON.stringify(verifyBody)
          },
          `verify Supabase OTP for ${input.email}`
        ),
        input.email
      );
    }

    const origin = appOrigin(input.appBaseUrl);
    const storageKey = storageKeyForSupabaseUrl(config.supabaseUrl);
    await writeStorageState(input.storageStatePath, origin, storageKey, session);
    return {
      role: input.role,
      email: input.email,
      storageStatePath: input.storageStatePath,
      storageKey,
      appOrigin: origin,
      method,
      session
    };
  }
}

function assertSeedPlan(plan: SupabaseSeedPlan): void {
  if (!plan.tables.length) throw new SupabaseAdapterError("supabase-seed-empty", "Supabase seed plan must list at least one table");
  for (const table of plan.tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)) {
      throw new SupabaseAdapterError("supabase-seed-table-invalid", `Refusing invalid table name ${table.name}`);
    }
    if (!plan.approvedTables.includes(table.name)) {
      throw new SupabaseAdapterError("supabase-seed-table-unapproved", `Refusing to write unapproved table ${table.name}`);
    }
    if (table.cascadeSafe !== true) {
      throw new SupabaseAdapterError("supabase-seed-cascade-unknown", `Refusing ${table.name}: cascade safety was not positively approved`);
    }
    const scopeKeys = Object.keys(table.scope);
    if (scopeKeys.length === 0) {
      throw new SupabaseAdapterError("supabase-seed-unscoped", `Refusing ${table.name}: seed rows must have a non-time scoped cleanup boundary`);
    }
    if (scopeKeys.some((key) => /time|date|created_at|updated_at/i.test(key))) {
      throw new SupabaseAdapterError("supabase-seed-timestamp-scope", `Refusing ${table.name}: timestamp scopes are not a safe reset boundary`);
    }
  }
}

function restTableUrl(config: SupabaseLocalConfig, table: SupabaseSeedTable): string {
  return `${config.supabaseUrl}/rest/v1/${encodeURIComponent(table.name)}`;
}

function scopeQuery(table: SupabaseSeedTable): string {
  const params = new URLSearchParams({ select: "*" });
  for (const [key, value] of Object.entries(table.scope).sort(([a], [b]) => a.localeCompare(b))) {
    params.append(key, `eq.${String(value)}`);
  }
  return params.toString();
}

function rowId(row: Record<string, unknown>, primaryKey: string): string {
  const value = row[primaryKey];
  return value === undefined || value === null ? sha256(stableJson(row)) : String(value);
}

function checksumRows(rows: Array<Record<string, unknown>>): string {
  const normalized = rows.map((row) => stableJson(row)).sort();
  return `sha256:${sha256(normalized.join("\n"))}`;
}

export function diffSupabaseSnapshots(before: SupabaseSeedSnapshot, after: SupabaseSeedSnapshot): SupabaseSeedDiff {
  const tables: SupabaseTableDiff[] = [];
  for (const beforeTable of before.tables) {
    const afterTable = after.tables.find((candidate) => candidate.table === beforeTable.table);
    if (!afterTable) {
      tables.push({
        table: beforeTable.table,
        inserted: 0,
        removed: beforeTable.count,
        changed: 0,
        beforeChecksum: beforeTable.checksum,
        afterChecksum: "missing",
        pass: false
      });
      continue;
    }
    const beforeRows = new Map(beforeTable.rows.map((row) => [rowId(row, beforeTable.primaryKey), stableJson(row)]));
    const afterRows = new Map(afterTable.rows.map((row) => [rowId(row, beforeTable.primaryKey), stableJson(row)]));
    let inserted = 0;
    let removed = 0;
    let changed = 0;
    for (const [id, row] of afterRows) {
      if (!beforeRows.has(id)) inserted += 1;
      else if (beforeRows.get(id) !== row) changed += 1;
    }
    for (const id of beforeRows.keys()) {
      if (!afterRows.has(id)) removed += 1;
    }
    tables.push({
      table: beforeTable.table,
      inserted,
      removed,
      changed,
      beforeChecksum: beforeTable.checksum,
      afterChecksum: afterTable.checksum,
      pass: beforeTable.checksum === afterTable.checksum
    });
  }
  return { runId: before.runId, pass: tables.every((table) => table.pass), tables };
}

export class SupabaseSeedAdapter {
  readonly id = "supabase" as const;

  constructor(private readonly options: SupabaseAdapterOptions = {}) {}

  async isolation(): Promise<SupabaseIsolationVerdict> {
    try {
      const config = await resolveSupabaseLocalConfig(this.options);
      const response = await fetchFor(this.options)(`${config.supabaseUrl}/rest/v1/`, { headers: serviceHeaders(config) });
      if (![200, 401, 404].includes(response.status)) {
        throw new SupabaseAdapterError("supabase-local-unavailable", `local Supabase API responded with ${response.status}`);
      }
      return {
        ok: true,
        strategy: "supabase-db-reset",
        isolation: "local-stack",
        destructiveAllowed: true,
        reasons: [
          "Supabase API is local",
          "Supabase DB URL is local Postgres",
          "Mailpit/Inbucket URL is local",
          "reset command is supabase db reset --local"
        ],
        resetCommand: "supabase db reset --local"
      };
    } catch (error) {
      return {
        ok: false,
        strategy: "supabase-db-reset",
        isolation: "unknown",
        destructiveAllowed: false,
        reasons: [error instanceof Error ? error.message : String(error)],
        resetCommand: "supabase db reset --local"
      };
    }
  }

  async seed(plan: SupabaseSeedPlan): Promise<SupabaseSeedReceipt> {
    assertSeedPlan(plan);
    const config = await resolveSupabaseLocalConfig(this.options);
    const fetchImpl = fetchFor(this.options);
    const inserted: SupabaseSeedReceipt["inserted"] = [];

    for (const table of plan.tables) {
      const rows = table.rows.map((row) => ({ ...table.scope, ...row }));
      const body = await requestJson<Array<Record<string, unknown>>>(
        fetchImpl,
        restTableUrl(config, table),
        {
          method: "POST",
          headers: { ...serviceHeaders(config), Prefer: "return=representation" },
          body: JSON.stringify(rows)
        },
        `seed Supabase table ${table.name}`
      );
      const primaryKey = table.primaryKey ?? "id";
      inserted.push({
        table: table.name,
        ids: body.map((row) => String(row[primaryKey] ?? sha256(stableJson(row)).slice(0, 12))),
        count: body.length
      });
    }

    return { runId: plan.runId, inserted };
  }

  async snapshot(plan: SupabaseSeedPlan): Promise<SupabaseSeedSnapshot> {
    assertSeedPlan(plan);
    const config = await resolveSupabaseLocalConfig(this.options);
    const fetchImpl = fetchFor(this.options);
    const tables: SupabaseTableSnapshot[] = [];

    for (const table of plan.tables) {
      const rows = await requestJson<Array<Record<string, unknown>>>(
        fetchImpl,
        `${restTableUrl(config, table)}?${scopeQuery(table)}`,
        { method: "GET", headers: serviceHeaders(config) },
        `snapshot Supabase table ${table.name}`
      );
      const primaryKey = table.primaryKey ?? "id";
      rows.sort((a, b) => rowId(a, primaryKey).localeCompare(rowId(b, primaryKey)));
      tables.push({
        table: table.name,
        primaryKey,
        scope: table.scope,
        checksum: checksumRows(rows),
        count: rows.length,
        rows
      });
    }

    return { runId: plan.runId, takenAt: new Date().toISOString(), tables };
  }

  diff(before: SupabaseSeedSnapshot, after: SupabaseSeedSnapshot): SupabaseSeedDiff {
    return diffSupabaseSnapshots(before, after);
  }

  async reset(): Promise<CommandResult> {
    const result = await commandFor(this.options)("supabase", ["db", "reset", "--local"], {
      cwd: projectRootFor(this.options),
      timeoutMs: 120_000
    });
    if (result.code !== 0) {
      throw new SupabaseAdapterError(
        "supabase-reset-failed",
        `supabase db reset --local failed. Is the local stack running? ${result.stderr.trim()}`
      );
    }
    return result;
  }
}
