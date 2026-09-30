import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContainerFirewallRunCommand,
  buildInternalDockerNetworkCommand,
  canaryBaseImage,
  runContainerCanaryMatrix
} from "../dist/egress.js";

// CommandResult helpers mirroring the spawn-based runner's shape.
const ok = (stdout) => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
const fail = (code, stderr) => ({ code, signal: null, stdout: "", stderr, timedOut: false });

// An injected command runner so the egress proof is exercised with no Docker daemon.
// It answers `docker info` (availability) and `docker run` (the canary) and records
// every call so the test can assert the containment flags that were actually used.
function makeRunner({ dockerAvailable = true, runResult, env } = {}) {
  const calls = [];
  const run = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    if (args[0] === "info") {
      return dockerAvailable
        ? ok('"24.0.0"')
        : fail(1, "Cannot connect to the Docker daemon");
    }
    return runResult;
  };
  return {
    calls,
    proof: () => runContainerCanaryMatrix({ runCommand: run, ...(env ? { env } : {}) }),
    dockerRun: () => calls.find((call) => call.args[0] === "run")
  };
}

const allBlocked = JSON.stringify({
  "fetch:ghost-canary": "blocked",
  "fetch:fake-stripe": "blocked",
  "https.request:ghost-canary": "blocked",
  "http.request:ghost-canary": "blocked"
});

test("all-blocked canary matrix proves containment", async () => {
  const runner = makeRunner({ runResult: ok(allBlocked) });
  const proof = await runner.proof();
  assert.equal(proof.proven, true);
  assert.equal(proof.dockerAvailable, true);
  assert.deepEqual(proof.errors, []);
});

test("an escaped probe fails the proof closed", async () => {
  const matrix = JSON.stringify({
    "fetch:ghost-canary": "escaped",
    "fetch:fake-stripe": "blocked",
    "https.request:ghost-canary": "blocked",
    "http.request:ghost-canary": "blocked"
  });
  const proof = await makeRunner({ runResult: ok(matrix) }).proof();
  assert.equal(proof.proven, false);
  assert.match(proof.errors[0], /escaped/i);
});

test("a non-zero docker exit fails closed", async () => {
  const proof = await makeRunner({ runResult: fail(125, "docker run failed") }).proof();
  assert.equal(proof.proven, false);
  assert.equal(proof.canaryMatrix.docker, "canary-failed");
});

test("an empty matrix fails closed (no proof over zero probes)", async () => {
  const proof = await makeRunner({ runResult: ok("{}") }).proof();
  assert.equal(proof.proven, false);
  assert.equal(proof.canaryMatrix.docker, "canary-unreadable");
});

test("non-JSON stdout fails closed instead of throwing", async () => {
  const proof = await makeRunner({ runResult: ok("not json at all") }).proof();
  assert.equal(proof.proven, false);
  assert.equal(proof.canaryMatrix.docker, "canary-unreadable");
});

test("a non-enum / non-string status fails closed", async () => {
  const numeric = await makeRunner({ runResult: ok(JSON.stringify({ "fetch:ghost-canary": 1 })) }).proof();
  assert.equal(numeric.proven, false);
  const garbage = await makeRunner({ runResult: ok(JSON.stringify({ "fetch:ghost-canary": "maybe" })) }).proof();
  assert.equal(garbage.proven, false);
  const array = await makeRunner({ runResult: ok("[]") }).proof();
  assert.equal(array.proven, false);
});

test("docker-unavailable degrades closed", async () => {
  const proof = await makeRunner({ dockerAvailable: false }).proof();
  assert.equal(proof.proven, false);
  assert.equal(proof.dockerAvailable, false);
  assert.match(proof.canaryMatrix.docker, /^not-run/);
});

test("the canary container pins --network none", async () => {
  const runner = makeRunner({ runResult: ok(allBlocked) });
  await runner.proof();
  const dockerRun = runner.dockerRun();
  assert.ok(dockerRun, "expected a `docker run` invocation");
  const networkIndex = dockerRun.args.indexOf("--network");
  assert.notEqual(networkIndex, -1, "containment requires --network");
  assert.equal(dockerRun.args[networkIndex + 1], "none");
});

test("the canary image is pinnable via GHOST_INVASION_CANARY_IMAGE", async () => {
  assert.equal(canaryBaseImage({}), "node:22-alpine");
  assert.equal(
    canaryBaseImage({ GHOST_INVASION_CANARY_IMAGE: "node:22-alpine@sha256:deadbeef" }),
    "node:22-alpine@sha256:deadbeef"
  );
  const runner = makeRunner({ runResult: ok(allBlocked), env: { GHOST_INVASION_CANARY_IMAGE: "pinned@sha256:cafe" } });
  await runner.proof();
  assert.ok(runner.dockerRun().args.includes("pinned@sha256:cafe"));
});

test("the internal trap network is created with --internal", () => {
  const command = buildInternalDockerNetworkCommand();
  assert.ok(command.includes("--internal"), "the trap network must be --internal");
  assert.ok(command.includes("--driver"));
});

test("the target run command pins the trap network, loopback binding, and image", () => {
  const command = buildContainerFirewallRunCommand({
    command: "node server.js",
    containerPort: 3000,
    hostPort: 4000
  });
  const networkIndex = command.indexOf("--network");
  assert.notEqual(networkIndex, -1);
  assert.equal(command[networkIndex + 1], "ghost-invasion-trap");
  assert.ok(command.some((arg) => arg === "127.0.0.1:4000:3000"), "host port must bind loopback only");
  assert.ok(command.includes("node:22-alpine"));
});
