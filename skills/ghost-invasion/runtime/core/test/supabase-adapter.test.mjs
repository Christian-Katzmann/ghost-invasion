import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SupabaseAuthAdapter,
  SupabaseSeedAdapter,
  diffSupabaseSnapshots,
  extractSupabaseOtp,
  resolveSupabaseLocalConfig
} from "../dist/supabase-adapter.js";
import { evaluateSafety } from "../dist/safety.js";

const localEnv = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_ANON_KEY: "local-anon",
  SUPABASE_SERVICE_ROLE_KEY: "local-service-role-secret",
  SUPABASE_DB_URL: "postgres://postgres:postgres@127.0.0.1:54322/postgres",
  SUPABASE_MAILPIT_URL: "http://127.0.0.1:54324",
  SUPABASE_JWT_SECRET: "local-jwt-secret"
};

const provenEgress = {
  mode: "container-firewall",
  proven: true,
  canaryMatrix: {
    "fetch:ghost-canary": "blocked",
    "fetch:fake-stripe": "blocked",
    "https.request:ghost-canary": "blocked",
    "http.request:ghost-canary": "blocked"
  },
  allowlist: ["localhost", "127.0.0.1"],
  dockerAvailable: true,
  errors: []
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function noStatusCommand(command, args) {
  if (command === "supabase" && args.join(" ") === "status -o json") {
    return Promise.resolve({ code: 127, stdout: "", stderr: "not needed for env-backed test" });
  }
  if (command === "supabase" && args.join(" ") === "db reset --local") {
    return Promise.resolve({ code: 0, stdout: "Reset local database", stderr: "" });
  }
  return Promise.resolve({ code: 1, stdout: "", stderr: `unexpected command ${command} ${args.join(" ")}` });
}

test("Supabase OTP extraction prefers token_hash and can fall back to six digit tokens", () => {
  assert.deepEqual(
    extractSupabaseOtp("Open http://127.0.0.1:54321/auth/v1/verify?token_hash=abc%2B123&type=email"),
    { tokenHash: "abc+123" }
  );
  assert.deepEqual(extractSupabaseOtp("Your login code is 123456."), { token: "123456" });
});

test("Supabase auth adapter provisions a user and mints replayable storageState from Mailpit token_hash", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-supabase-auth-"));
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push({ url, init });
    if (url.endsWith("/auth/v1/admin/users")) {
      assert.equal(init.headers.Authorization, "Bearer local-service-role-secret");
      return jsonResponse({ user: { id: "user-a", email: "member@example.test" } }, 201);
    }
    if (url.endsWith("/auth/v1/otp")) {
      assert.equal(JSON.parse(init.body).create_user, false);
      return jsonResponse({});
    }
    if (url.includes("/api/v1/messages")) {
      return jsonResponse({ messages: [{ ID: "message-1" }] });
    }
    if (url.includes("/api/v1/message/message-1")) {
      return jsonResponse({
        Text: "For member@example.test: http://127.0.0.1:54321/auth/v1/verify?token_hash=hash-123&type=email"
      });
    }
    if (url.endsWith("/auth/v1/verify")) {
      assert.deepEqual(JSON.parse(init.body), { type: "email", token_hash: "hash-123" });
      return jsonResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        user: { id: "user-a", email: "member@example.test" }
      });
    }
    return jsonResponse({ message: `unhandled ${url}` }, 404);
  };

  try {
    const adapter = new SupabaseAuthAdapter({ projectRoot: cwd, env: localEnv, fetchImpl, runCommand: noStatusCommand });
    const [user] = await adapter.provisionUsers([{ role: "member", email: "member@example.test" }]);
    assert.deepEqual(user, { role: "member", email: "member@example.test", id: "user-a" });

    const storageStatePath = join(cwd, ".ghost", "runtime", "auth", "member.storageState.json");
    const session = await adapter.mintSession({
      role: "member",
      email: "member@example.test",
      appBaseUrl: "http://127.0.0.1:5173",
      storageStatePath,
      timeoutMs: 50,
      pollIntervalMs: 1
    });

    assert.equal(session.storageKey, "sb-127-auth-token");
    assert.equal(session.appOrigin, "http://127.0.0.1:5173");
    const storageState = JSON.parse(await readFile(storageStatePath, "utf8"));
    assert.equal(storageState.origins[0].origin, "http://127.0.0.1:5173");
    assert.equal(storageState.origins[0].localStorage[0].name, "sb-127-auth-token");
    assert.equal(JSON.stringify(storageState).includes("local-service-role-secret"), false);
    assert(requests.some((request) => request.url.endsWith("/auth/v1/verify")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Supabase seed adapter verifies local isolation, scopes writes, diffs snapshots, and resets locally", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-supabase-seed-"));
  const snapshotQueue = [
    [],
    [{ id: "project-1", ghost_run_id: "run-1", owner_id: "user-a", name: "Seeded" }]
  ];
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push({ url, init });
    if (url.endsWith("/rest/v1/")) return jsonResponse({}, 404);
    if (url.endsWith("/rest/v1/projects") && init.method === "POST") {
      const rows = JSON.parse(init.body);
      assert.equal(rows[0].ghost_run_id, "run-1");
      return jsonResponse([{ id: "project-1", ...rows[0] }], 201);
    }
    if (url.includes("/rest/v1/projects?")) {
      assert(url.includes("ghost_run_id=eq.run-1"));
      return jsonResponse(snapshotQueue.shift() ?? []);
    }
    return jsonResponse({ message: `unhandled ${url}` }, 404);
  };

  try {
    const adapter = new SupabaseSeedAdapter({ projectRoot: cwd, env: localEnv, fetchImpl, runCommand: noStatusCommand });
    const isolation = await adapter.isolation();
    assert.equal(isolation.ok, true);
    assert.equal(isolation.isolation, "local-stack");
    assert.equal(isolation.destructiveAllowed, true);

    const plan = {
      runId: "run-1",
      approvedTables: ["projects"],
      tables: [
        {
          name: "projects",
          primaryKey: "id",
          cascadeSafe: true,
          scope: { ghost_run_id: "run-1" },
          rows: [{ owner_id: "user-a", name: "Seeded" }]
        }
      ]
    };

    const before = await adapter.snapshot(plan);
    const receipt = await adapter.seed(plan);
    const after = await adapter.snapshot(plan);
    const diff = diffSupabaseSnapshots(before, after);
    assert.deepEqual(receipt.inserted, [{ table: "projects", ids: ["project-1"], count: 1 }]);
    assert.equal(diff.pass, false);
    assert.equal(diff.tables[0].inserted, 1);

    const reset = await adapter.reset();
    assert.equal(reset.code, 0);
    assert(requests.every((request) => !String(request.url).toLowerCase().includes("truncate")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Supabase seed adapter refuses unapproved cascade or timestamp cleanup boundaries", async () => {
  const adapter = new SupabaseSeedAdapter({ env: localEnv, runCommand: noStatusCommand });
  assert.equal(
    adapter.diff({ runId: "run", takenAt: new Date().toISOString(), tables: [] }, { runId: "run", takenAt: new Date().toISOString(), tables: [] }).pass,
    true
  );

  await assert.rejects(
    () =>
      adapter.seed({
        runId: "run",
        approvedTables: ["projects"],
        tables: [{ name: "projects", scope: { created_at: "today" }, rows: [], cascadeSafe: true }]
      }),
    /timestamp scopes/
  );
  await assert.rejects(
    () =>
      adapter.seed({
        runId: "run",
        approvedTables: ["projects"],
        tables: [{ name: "projects", scope: { ghost_run_id: "run" }, rows: [] }]
      }),
    /cascade safety/
  );
});

test("Supabase config refuses an off-box SUPABASE_URL", async () => {
  await assert.rejects(
    () => resolveSupabaseLocalConfig({ env: { ...localEnv, SUPABASE_URL: "https://my-project.supabase.co" }, runCommand: noStatusCommand }),
    (error) => {
      assert.equal(error.code, "supabase-not-local");
      assert.match(error.message, /my-project\.supabase\.co/);
      return true;
    }
  );
});

test("Supabase config refuses an off-box SUPABASE_DB_URL", async () => {
  await assert.rejects(
    () =>
      resolveSupabaseLocalConfig({
        env: { ...localEnv, SUPABASE_DB_URL: "postgres://postgres:postgres@db.prod.example.com:5432/postgres" },
        runCommand: noStatusCommand
      }),
    (error) => {
      assert.equal(error.code, "supabase-db-not-local");
      assert.match(error.message, /db\.prod\.example\.com/);
      return true;
    }
  );
});

// Regression lock: a future refactor that weakens isLocalHostname (e.g. substring matching)
// would let an off-box host masquerade as local. This off-box URL must keep throwing.
test("Supabase config keeps refusing an off-box SUPABASE_URL even when it embeds a localhost label", async () => {
  await assert.rejects(
    () => resolveSupabaseLocalConfig({ env: { ...localEnv, SUPABASE_URL: "https://localhost.attacker.example:54321" }, runCommand: noStatusCommand }),
    (error) => {
      assert.equal(error.code, "supabase-not-local");
      return true;
    }
  );
});

// S-013: `startsWith("127.")` accepted `127.0.0.1.evil.example` — an off-box domain that merely
// begins with the loopback prefix. The numeric 127.0.0.0/8 check must reject it.
test("Supabase config refuses a loopback-prefixed off-box SUPABASE_URL (127.0.0.1.evil.example)", async () => {
  await assert.rejects(
    () => resolveSupabaseLocalConfig({ env: { ...localEnv, SUPABASE_URL: "http://127.0.0.1.evil.example:54321" }, runCommand: noStatusCommand }),
    (error) => {
      assert.equal(error.code, "supabase-not-local");
      assert.match(error.message, /127\.0\.0\.1\.evil\.example/);
      return true;
    }
  );
});

test("Safety gate accepts Supabase-local reset while warning about service-role scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-supabase-safety-"));
  try {
    const verdict = await evaluateSafety({
      baseUrl: "http://127.0.0.1:5173",
      cwd,
      env: { SUPABASE_SERVICE_ROLE_KEY: "local-service-role-secret" },
      egressProof: provenEgress,
      resetStrategy: "supabase-db-reset",
      dataIsolation: "local-stack"
    });

    assert.equal(verdict.verdict, "allow-with-warnings");
    assert.equal(verdict.dataReset.strategy, "supabase-db-reset");
    assert.equal(verdict.dataReset.isolation, "local-stack");
    assert.equal(verdict.dataReset.destructiveAllowed, true);
    assert.match(verdict.explain, /warnings/i);
    assert.equal(JSON.stringify(verdict).includes("local-service-role-secret"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
