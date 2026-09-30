import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FirebaseAuthAdapter } from "../dist/firebase-adapter.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("Firebase adapter creates emulator user and writes localStorage storageState", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-firebase-auth-"));
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push({ url, init });
    assert(url.startsWith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp"));
    const body = JSON.parse(init.body);
    assert.equal(body.returnSecureToken, true);
    return jsonResponse({
      idToken: "id-token",
      email: body.email,
      refreshToken: "refresh-token",
      expiresIn: "3600",
      localId: "firebase-user-1"
    });
  };
  const storageStatePath = join(cwd, ".ghost", "runtime", "auth", "member.storageState.json");

  try {
    const result = await new FirebaseAuthAdapter({
      emulatorUrl: "127.0.0.1:9099",
      projectId: "ghost-local",
      apiKey: "fake-api-key",
      fetchImpl
    }).mintSession({
      role: "member",
      email: "member@example.test",
      password: "local-password",
      appBaseUrl: "http://127.0.0.1:5173",
      storageStatePath
    });

    assert.equal(result.uid, "firebase-user-1");
    assert.equal(result.storageKey, "firebase:authUser:fake-api-key:[DEFAULT]");
    assert.equal(requests.length, 1);
    const storageState = JSON.parse(await readFile(storageStatePath, "utf8"));
    assert.equal(storageState.origins[0].origin, "http://127.0.0.1:5173");
    const authEntry = storageState.origins[0].localStorage.find((entry) => entry.name === result.storageKey);
    assert(authEntry, "expected Firebase auth localStorage entry");
    const authUser = JSON.parse(authEntry.value);
    assert.equal(authUser.uid, "firebase-user-1");
    assert.equal(authUser.stsTokenManager.accessToken, "id-token");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function rejectingFetch() {
  throw new Error("Firebase adapter must not reach the network for a non-local emulator host");
}

test("Firebase adapter refuses an off-box FIREBASE_AUTH_EMULATOR_HOST before any request", async () => {
  await assert.rejects(
    () =>
      new FirebaseAuthAdapter({ env: { FIREBASE_AUTH_EMULATOR_HOST: "identitytoolkit.googleapis.com" }, fetchImpl: rejectingFetch }).mintSession({
        role: "member",
        email: "member@example.test",
        password: "local-password",
        appBaseUrl: "http://127.0.0.1:5173",
        storageStatePath: join(tmpdir(), "member.storageState.json")
      }),
    (error) => {
      assert.equal(error.code, "firebase-emulator-not-local");
      assert.match(error.message, /identitytoolkit\.googleapis\.com/);
      return true;
    }
  );
});

test("Firebase adapter refuses an off-box emulatorUrl option even on a private-LAN host", async () => {
  await assert.rejects(
    () =>
      new FirebaseAuthAdapter({ emulatorUrl: "http://10.0.0.5:9099", fetchImpl: rejectingFetch }).mintSession({
        role: "member",
        email: "member@example.test",
        password: "local-password",
        appBaseUrl: "http://127.0.0.1:5173",
        storageStatePath: join(tmpdir(), "member.storageState.json")
      }),
    (error) => {
      assert.equal(error.code, "firebase-emulator-not-local");
      return true;
    }
  );
});

// Regression lock: substring-style weakening of the local-host check would let a host that
// merely contains "localhost"/"127.0.0.1" through. This off-box host must keep throwing.
test("Firebase adapter keeps refusing an off-box host that embeds a localhost label", async () => {
  await assert.rejects(
    () =>
      new FirebaseAuthAdapter({ emulatorUrl: "http://localhost.attacker.example:9099", fetchImpl: rejectingFetch }).mintSession({
        role: "member",
        email: "member@example.test",
        password: "local-password",
        appBaseUrl: "http://127.0.0.1:5173",
        storageStatePath: join(tmpdir(), "member.storageState.json")
      }),
    (error) => {
      assert.equal(error.code, "firebase-emulator-not-local");
      return true;
    }
  );
});

// S-013: `startsWith("127.")` accepted `127.0.0.1.evil.example` — an off-box domain that merely
// begins with the loopback prefix. The numeric 127.0.0.0/8 check must reject it.
test("Firebase adapter refuses a loopback-prefixed off-box emulator host (127.0.0.1.evil.example)", async () => {
  await assert.rejects(
    () =>
      new FirebaseAuthAdapter({ emulatorUrl: "http://127.0.0.1.evil.example:9099", fetchImpl: rejectingFetch }).mintSession({
        role: "member",
        email: "member@example.test",
        password: "local-password",
        appBaseUrl: "http://127.0.0.1:5173",
        storageStatePath: join(tmpdir(), "member.storageState.json")
      }),
    (error) => {
      assert.equal(error.code, "firebase-emulator-not-local");
      assert.match(error.message, /127\.0\.0\.1\.evil\.example/);
      return true;
    }
  );
});

test("Firebase adapter falls back to sign-in when emulator user already exists", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (url.includes("accounts:signUp")) {
      return jsonResponse({ error: { message: "EMAIL_EXISTS" } }, 400);
    }
    assert(url.includes("accounts:signInWithPassword"));
    return jsonResponse({
      idToken: "id-token",
      email: JSON.parse(init.body).email,
      refreshToken: "refresh-token",
      expiresIn: "3600",
      localId: "firebase-user-1"
    });
  };
  const cwd = await mkdtemp(join(tmpdir(), "ghost-firebase-existing-"));
  try {
    await new FirebaseAuthAdapter({ emulatorUrl: "http://127.0.0.1:9099", fetchImpl }).mintSession({
      role: "member",
      email: "member@example.test",
      password: "local-password",
      appBaseUrl: "http://127.0.0.1:5173",
      storageStatePath: join(cwd, ".ghost", "runtime", "auth", "member.storageState.json")
    });
    assert.equal(calls.length, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
