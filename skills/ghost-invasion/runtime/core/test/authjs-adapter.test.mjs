import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@auth/core/jwt";
import { AuthJsAuthAdapter } from "../dist/authjs-adapter.js";

const authSecret = "test-auth-secret-with-enough-entropy-for-encrypted-jwt-sessions";

test("Auth.js adapter mints a replayable encrypted session cookie storageState", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-authjs-"));
  const storageStatePath = join(cwd, ".ghost", "runtime", "auth", "member.storageState.json");
  try {
    const adapter = new AuthJsAuthAdapter({ env: { AUTH_SECRET: authSecret } });
    const result = await adapter.mintSession({
      role: "member",
      email: "member@example.test",
      userId: "user-authjs-1",
      name: "Member Example",
      appBaseUrl: "http://127.0.0.1:3000",
      storageStatePath,
      ttlSeconds: 900
    });

    assert.equal(result.cookieName, "authjs.session-token");
    assert.equal(result.subject, "user-authjs-1");
    const storageState = JSON.parse(await readFile(storageStatePath, "utf8"));
    assert.equal(storageState.origins.length, 0);
    assert.equal(storageState.cookies[0].name, "authjs.session-token");
    assert.equal(storageState.cookies[0].domain, "127.0.0.1");
    assert.equal(storageState.cookies[0].httpOnly, true);
    assert.equal(storageState.cookies[0].secure, false);
    assert.equal(JSON.stringify(storageState).includes(authSecret), false);

    const token = await decode({
      token: storageState.cookies[0].value,
      secret: authSecret,
      salt: storageState.cookies[0].name
    });
    assert.equal(token?.sub, "user-authjs-1");
    assert.equal(token?.email, "member@example.test");
    assert.equal(token?.role, "member");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Auth.js adapter refuses a non-local appBaseUrl before minting a session", async () => {
  const adapter = new AuthJsAuthAdapter({ env: { AUTH_SECRET: authSecret } });
  await assert.rejects(
    () =>
      adapter.mintSession({
        role: "member",
        email: "member@example.test",
        appBaseUrl: "https://app.production.example.com",
        storageStatePath: join(tmpdir(), "member.storageState.json")
      }),
    (error) => {
      assert.equal(error.code, "authjs-app-not-local");
      assert.match(error.message, /app\.production\.example\.com/);
      return true;
    }
  );
});

// S-013: `startsWith("127.")` accepted `127.0.0.1.evil.example` — an off-box domain that merely
// begins with the loopback prefix. The numeric 127.0.0.0/8 check must reject it.
test("Auth.js adapter refuses a loopback-prefixed off-box appBaseUrl (127.0.0.1.evil.example)", async () => {
  const adapter = new AuthJsAuthAdapter({ env: { AUTH_SECRET: authSecret } });
  await assert.rejects(
    () =>
      adapter.mintSession({
        role: "member",
        email: "member@example.test",
        appBaseUrl: "http://127.0.0.1.evil.example:3000",
        storageStatePath: join(tmpdir(), "member.storageState.json")
      }),
    (error) => {
      assert.equal(error.code, "authjs-app-not-local");
      assert.match(error.message, /127\.0\.0\.1\.evil\.example/);
      return true;
    }
  );
});
