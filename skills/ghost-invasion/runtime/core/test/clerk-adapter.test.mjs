import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClerkAuthAdapter } from "../dist/clerk-adapter.js";

test("Clerk adapter writes test-token storageState for +clerk_test emails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-clerk-auth-"));
  const storageStatePath = join(cwd, ".ghost", "runtime", "auth", "member.storageState.json");
  try {
    const result = await new ClerkAuthAdapter().mintSession({
      role: "member",
      email: "member+clerk_test@example.test",
      appBaseUrl: "http://127.0.0.1:5173",
      storageStatePath,
      testingToken: "test-token-123",
      publishableKey: "pk_test_example"
    });

    assert.equal(result.testingTokenQueryParam, "__clerk_testing_token");
    const storageState = JSON.parse(await readFile(storageStatePath, "utf8"));
    assert.equal(storageState.cookies[0].name, "__clerk_testing_token");
    assert.equal(storageState.cookies[0].domain, "127.0.0.1");
    assert.equal(storageState.origins[0].origin, "http://127.0.0.1:5173");
    assert(storageState.origins[0].localStorage.some((entry) => entry.name === "__clerk_testing_token" && entry.value === "test-token-123"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Clerk adapter refuses non-test email aliases", async () => {
  const adapter = new ClerkAuthAdapter();
  await assert.rejects(
    () =>
      adapter.mintSession({
        role: "member",
        email: "member@example.test",
        appBaseUrl: "http://127.0.0.1:5173",
        storageStatePath: join(tmpdir(), "member.storageState.json"),
        testingToken: "test-token-123"
      }),
    /clerk_test/
  );
});

test("Clerk adapter refuses a non-local appBaseUrl before minting a session", async () => {
  const adapter = new ClerkAuthAdapter();
  await assert.rejects(
    () =>
      adapter.mintSession({
        role: "member",
        email: "member+clerk_test@example.test",
        appBaseUrl: "https://app.production.example.com",
        storageStatePath: join(tmpdir(), "member.storageState.json"),
        testingToken: "test-token-123"
      }),
    (error) => {
      assert.equal(error.code, "clerk-app-not-local");
      assert.match(error.message, /app\.production\.example\.com/);
      return true;
    }
  );
});

// S-013: `startsWith("127.")` accepted `127.0.0.1.evil.example` — an off-box domain that merely
// begins with the loopback prefix. The numeric 127.0.0.0/8 check must reject it.
test("Clerk adapter refuses a loopback-prefixed off-box appBaseUrl (127.0.0.1.evil.example)", async () => {
  const adapter = new ClerkAuthAdapter();
  await assert.rejects(
    () =>
      adapter.mintSession({
        role: "member",
        email: "member+clerk_test@example.test",
        appBaseUrl: "http://127.0.0.1.evil.example:5173",
        storageStatePath: join(tmpdir(), "member.storageState.json"),
        testingToken: "test-token-123"
      }),
    (error) => {
      assert.equal(error.code, "clerk-app-not-local");
      assert.match(error.message, /127\.0\.0\.1\.evil\.example/);
      return true;
    }
  );
});
