import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApiVolumeTier, selectApiTierTargets } from "../dist/api-tier.js";

function restSurface(id, path) {
  return { id, kind: "api", mutationTier: "rest", methods: ["GET"], routes: [{ path }] };
}

function planWithApiTier(overrides = {}) {
  return {
    swarm: {
      apiTier: { enabled: true, engine: "fetch", rps: 0, targets: [], ...overrides }
    }
  };
}

function recordingEvidence(runRoot) {
  const events = [];
  return {
    runRoot,
    events,
    append: async (event) => {
      events.push(event);
    }
  };
}

// Guard against accidental real network egress: if the local assert ever regresses, a
// stubbed fetch makes the failure loud instead of firing a real request off-box.
function failingFetch() {
  throw new Error("api-tier must not issue a real fetch against a non-local baseUrl");
}

test("API tier refuses a non-local fetch baseUrl before issuing any request", async () => {
  const evidence = recordingEvidence(await mkdtemp(join(tmpdir(), "ghost-api-tier-")));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = failingFetch;
  try {
    await assert.rejects(
      () =>
        runApiVolumeTier({
          projectRoot: evidence.runRoot,
          baseUrl: "https://app.production.example.com",
          plan: planWithApiTier(),
          evidence,
          surfacesPath: join(evidence.runRoot, "missing-surfaces.json")
        }),
      /non-local baseUrl \(host=app\.production\.example\.com\)/
    );
    assert.equal(evidence.events.length, 0, "no evidence should be emitted before the local assert passes");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(evidence.runRoot, { recursive: true, force: true });
  }
});

test("API tier refuses a non-local k6 baseUrl before shelling out to the binary", async () => {
  const evidence = recordingEvidence(await mkdtemp(join(tmpdir(), "ghost-api-tier-k6-")));
  try {
    await assert.rejects(
      () =>
        runApiVolumeTier({
          projectRoot: evidence.runRoot,
          baseUrl: "http://api.production.example.net:8080",
          plan: planWithApiTier({ engine: "k6" }),
          evidence,
          surfacesPath: join(evidence.runRoot, "missing-surfaces.json")
        }),
      /non-local baseUrl \(host=api\.production\.example\.net\)/
    );
    assert.equal(evidence.events.length, 0);
  } finally {
    await rm(evidence.runRoot, { recursive: true, force: true });
  }
});

test("API tier refuses an unparseable baseUrl", async () => {
  const evidence = recordingEvidence(await mkdtemp(join(tmpdir(), "ghost-api-tier-bad-")));
  try {
    await assert.rejects(
      () =>
        runApiVolumeTier({
          projectRoot: evidence.runRoot,
          baseUrl: "not-a-url",
          plan: planWithApiTier(),
          evidence,
          surfacesPath: join(evidence.runRoot, "missing-surfaces.json")
        }),
      /unparseable baseUrl/
    );
  } finally {
    await rm(evidence.runRoot, { recursive: true, force: true });
  }
});

// F2: targets are built `new URL(route, base)` with an unconstrained `route`. An absolute or
// protocol-relative route discards the local base and resolves off-box; the resolved host must
// be re-validated and any non-local target dropped so no host-side fetch/k6 hits it.
test("selectApiTierTargets drops a target whose route resolves off-box (absolute + protocol-relative)", () => {
  const surfaces = [
    restSurface("rest-local", "/api/items"),
    restSurface("rest-absolute", "http://evil.example/x"),
    restSurface("rest-protocol-relative", "//evil.example/x")
  ];
  const targets = selectApiTierTargets(surfaces, [], "http://127.0.0.1:5173");
  assert.deepEqual(
    targets.map((target) => target.url),
    ["http://127.0.0.1:5173/api/items"],
    "only the locally-resolving target should survive"
  );
  assert.equal(
    targets.some((target) => target.url.includes("evil.example")),
    false,
    "no off-box host may appear in the resolved targets"
  );
});

// F2 end-to-end: an off-box route in discovered-surfaces.json must produce zero targets and fire
// zero outbound requests. A failing fetch stub makes any regression loud instead of off-box.
test("API tier fires no request for an off-box resolved route", async () => {
  const evidence = recordingEvidence(await mkdtemp(join(tmpdir(), "ghost-api-tier-offbox-")));
  const surfacesPath = join(evidence.runRoot, "discovered-surfaces.json");
  await writeFile(surfacesPath, JSON.stringify({ surfaces: [restSurface("rest-absolute", "http://evil.example/pwn")] }), "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = failingFetch;
  try {
    const result = await runApiVolumeTier({
      projectRoot: evidence.runRoot,
      baseUrl: "http://127.0.0.1:5173",
      plan: planWithApiTier(),
      evidence,
      surfacesPath
    });
    assert.equal(result.requests, 0);
    assert.equal(result.skippedReason, "no-rest-surfaces");
    assert.equal(
      evidence.events.some((event) => event.type === "api-tier-request"),
      false,
      "no api-tier-request event should fire for an off-box target"
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(evidence.runRoot, { recursive: true, force: true });
  }
});

// S-013 on the API tier: `startsWith("127.")` accepted `127.0.0.1.evil.example` as loopback.
test("API tier refuses a loopback-prefixed off-box baseUrl (127.0.0.1.evil.example)", async () => {
  const evidence = recordingEvidence(await mkdtemp(join(tmpdir(), "ghost-api-tier-spoof-")));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = failingFetch;
  try {
    await assert.rejects(
      () =>
        runApiVolumeTier({
          projectRoot: evidence.runRoot,
          baseUrl: "http://127.0.0.1.evil.example:5173",
          plan: planWithApiTier(),
          evidence,
          surfacesPath: join(evidence.runRoot, "missing-surfaces.json")
        }),
      /non-local baseUrl \(host=127\.0\.0\.1\.evil\.example\)/
    );
    assert.equal(evidence.events.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(evidence.runRoot, { recursive: true, force: true });
  }
});

test("API tier accepts a local baseUrl and proceeds without real traffic when no surfaces exist", async () => {
  const evidence = recordingEvidence(await mkdtemp(join(tmpdir(), "ghost-api-tier-ok-")));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = failingFetch;
  try {
    const result = await runApiVolumeTier({
      projectRoot: evidence.runRoot,
      baseUrl: "http://127.0.0.1:5173",
      plan: planWithApiTier(),
      evidence,
      surfacesPath: join(evidence.runRoot, "missing-surfaces.json")
    });
    assert.equal(result.enabled, true);
    assert.equal(result.requests, 0);
    assert.equal(result.skippedReason, "no-rest-surfaces");
    assert(evidence.events.some((event) => event.type === "api-tier-start"));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(evidence.runRoot, { recursive: true, force: true });
  }
});
