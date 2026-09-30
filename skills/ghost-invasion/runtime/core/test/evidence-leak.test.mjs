import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import zlib from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwarm } from "../dist/swarm.js";
import { planHash } from "../dist/planner.js";
import { renderDashboardHtml } from "../dist/dashboard.js";

// The operator's live session secret. It is planted into a Playwright storageState so
// authenticated drones send it as a Cookie on every request, and the target echoes it
// back in a captured response body. After the run it must appear in NONE of the
// evidence artifacts CI uploads or the dashboard serves.
const SESSION_SECRET = "GHOSTLEAK-s3ss10n-c0okie-DO-NOT-PERSIST-7f3a9b2c";

const cleanEnv = {};

// Minimal NDJSON/text zip reader (read-only) so the test can prove the trace's
// compressed entries are secret-free without shelling out to `unzip`.
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0, "trace.zip has no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, "bad central directory header");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function writeResetConfig(projectRoot) {
  const configDir = join(projectRoot, ".ghost", "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "reset.json"),
    `${JSON.stringify({
      schemaVersion: "1.0",
      strategy: "user-command",
      isolation: "user-reset",
      resetCommand: "true",
      seedCommand: null,
      runsBefore: ["mutating-swarm"],
      runsAfter: ["mutating-swarm"],
      destructiveAllowed: true,
      userOwnedBoundary: true,
      updatedAt: "2026-06-01T00:00:00.000Z"
    }, null, 2)}\n`
  );
}

// Plant the live cookie into a storageState the drone authenticates from.
async function writeStorageState(projectRoot, stateRef) {
  const authDir = join(projectRoot, ".ghost", "runtime", "auth");
  await mkdir(authDir, { recursive: true });
  await writeFile(
    join(authDir, stateRef),
    JSON.stringify({
      cookies: [
        {
          name: "session",
          value: SESSION_SECRET,
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax"
        }
      ],
      origins: []
    })
  );
}

// A double-submit endpoint (to force a failing journey → trace capture) plus an
// /api/echo that reflects the incoming Cookie header into its JSON body.
function createServer() {
  let sequence = 0;
  let projects = [{ id: "seed-a", ownerId: "user-a", name: "Seed A", notes: "", createdAt: "2026-05-30T10:00:00.000Z" }];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/echo") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, seenCookie: request.headers.cookie ?? null }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/reset") {
      sequence = 0;
      projects = [{ id: "seed-a", ownerId: "user-a", name: "Seed A", notes: "", createdAt: "2026-05-30T10:00:00.000Z" }];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      sequence += 1;
      projects.push({ id: `project-${sequence}`, ownerId: "user-a", name: String(body.name ?? ""), notes: "", createdAt: new Date().toISOString() });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ project: projects.at(-1) }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/projects/new") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body><main><h1>Create project</h1>
        <form><label>Project name <input aria-label="Project name" name="name" /></label>
        <button type="submit">Create</button></form></main>
        <script>
          const form = document.querySelector('form');
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const name = new FormData(form).get('name');
            fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
          });
        </script></body></html>`);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return {
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address === "object");
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function writeLeakPlan(projectRoot, baseUrl) {
  const planDir = join(projectRoot, ".ghost", "plan");
  await mkdir(planDir, { recursive: true });
  const planPath = join(planDir, "ghost-invasion-plan.json");
  const plan = {
    $schema: "ghost-invasion/plan@1",
    createdAt: new Date().toISOString(),
    target: { baseUrl, stack: "manual", auth: "generic" },
    mode: "quick",
    pack: "launch-readiness",
    seed: 1337,
    safety: {
      targetRisk: "local",
      hardStop: false,
      egress: { mode: "container-firewall", proven: true, allowlist: ["localhost", "127.0.0.1"] },
      liveSecrets: [],
      mocksApplied: [],
      dataReset: { strategy: "user-command", isolation: "user-reset", destructiveAllowed: true },
      approvalRequired: false
    },
    swarm: {
      browserConcurrency: 1,
      browserWaves: 1,
      totalBrowserSessions: 1,
      apiTier: { enabled: false, engine: "fetch", rps: 0, targets: [] },
      rateLimits: { rampMsPerContext: 750, circuitBreaker: "3%5xx|429" }
    },
    personas: [
      {
        $schema: "ghost-invasion/persona@1",
        id: "authed-user",
        archetype: "chaotic_user",
        // Authenticate from the planted storageState so the live cookie is on the wire.
        role: { name: "member", authStrategy: "storage-state", stateRef: "leak-state.json" },
        device: { preset: "Desktop Chrome", viewport: { width: 1280, height: 800 }, touch: false, scaleFactor: 1 },
        network: { profile: "fast", downKbps: 10000, upKbps: 5000, latencyMs: 20 },
        patience: { actionTimeoutMs: 5000, maxWaitBeforeRageMs: 5000, giveUpAfterSteps: 4 },
        mistakePattern: { missThreshold: 0, doubleSubmit: false, refreshMidFlow: false, backDuringSave: false, typoRate: 0 },
        timing: { thinkTimeMs: [0, 0], typeDelayMs: [0, 0] },
        dataState: { inputProfile: "test", recordCountBefore: 0, fixtureRef: "test" }
      }
    ],
    journeys: [
      {
        $schema: "ghost-invasion/journey@1",
        id: "double-click-save",
        name: "Double-click Create creates duplicates",
        goal: "Double submit should not create duplicate projects.",
        appliesToPersonas: ["authed-user"],
        invariantsTested: ["mutation.idempotent-create"],
        pristineRequired: true,
        anchors: { routes: ["/projects/new"], mutations: ["POST /api/projects"], surfaceHash: "sha256:test" },
        idealPath: ["goto:/projects/new", "fill:name=Launch plan", "clickRole:button:Create"],
        steps: [
          { type: "goto", url: "/projects/new" },
          // Captures a response body that echoes the live cookie → response-body.json.
          { type: "apiCall", method: "GET", url: "/api/echo", expectStatus: 200, captureResponseBody: true },
          { type: "fill", selector: "role=textbox[name=/project name/i]", value: "Launch plan" },
          { type: "dbSnapshot", id: "before", table: "projects", url: "/api/projects" },
          { type: "doubleSubmit", role: "button", name: "Create", gapMs: 20, cause: "ghost-injected" },
          { type: "wait", ms: 50 },
          { type: "dbSnapshot", id: "after", table: "projects", url: "/api/projects" }
        ],
        success: [
          {
            type: "expectDbDiff",
            table: "projects",
            before: "before",
            after: "after",
            where: { name: "Launch plan" },
            expectInserted: 1,
            label: "Duplicate project created on double-click"
          }
        ],
        abandon: []
      }
    ],
    surfaceHash: "sha256:test",
    approvedPlanHash: null
  };
  plan.approvedPlanHash = planHash(plan); // every mutating run requires an approved plan
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return planPath;
}

test("evidence artifacts never persist the live session cookie", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-leak-"));
  const app = createServer();
  const baseUrl = await app.start();
  try {
    await writeStorageState(cwd, "leak-state.json");
    await writeResetConfig(cwd);
    const planPath = await writeLeakPlan(cwd, baseUrl);

    const result = await runSwarm({ projectRoot: cwd, planPath, workers: 1, reproductionBudget: 0, runReset: false, env: cleanEnv });

    // The journey failed (double-submit duplicates), so a traced retry ran.
    assert.equal(result.totals.failed, 1);
    assert.equal(result.totals.tracedFailures, 1);

    const evidenceRoot = join(result.runRoot, "evidence");
    const droneDirs = await readdir(evidenceRoot);
    assert(droneDirs.length > 0, "expected drone evidence directories");

    let sawHar = false;
    let sawTrace = false;
    let sawResponseBody = false;

    for (const dir of droneDirs) {
      const droneDir = join(evidenceRoot, dir);
      const files = await readdir(droneDir);

      if (files.includes("network.har")) {
        sawHar = true;
        const har = await readFile(join(droneDir, "network.har"), "utf8");
        assert(!har.includes(SESSION_SECRET), `network.har leaked the session secret (${dir})`);
        assert(har.includes("<ghost-redacted>"), "network.har should show the redaction marker");
      }

      if (files.includes("trace.zip")) {
        sawTrace = true;
        const entries = readZipEntries(await readFile(join(droneDir, "trace.zip")));
        for (const entry of entries) {
          assert(
            !entry.data.includes(Buffer.from(SESSION_SECRET)),
            `trace.zip entry ${entry.name} leaked the session secret (${dir})`
          );
        }
      }

      if (files.includes("response-body.json")) {
        sawResponseBody = true;
        const body = await readFile(join(droneDir, "response-body.json"), "utf8");
        assert(!body.includes(SESSION_SECRET), `response-body.json leaked the session secret (${dir})`);
        const parsed = JSON.parse(body);
        assert.equal(parsed.capturedFrom, "target");
        assert(typeof parsed.bodyOwnership === "string" && parsed.bodyOwnership.includes("target-owned"));
      }
    }

    assert(sawHar, "expected a captured network.har to verify");
    assert(sawTrace, "expected a captured trace.zip to verify");
    assert(sawResponseBody, "expected a captured response-body.json to verify");

    // Human-facing artifacts: report.md, summary.html, and the live dashboard HTML.
    const reportMarkdown = await readFile(join(result.runRoot, "report.md"), "utf8");
    assert(!reportMarkdown.includes(SESSION_SECRET), "report.md leaked the session secret");
    const summaryHtml = await readFile(join(result.runRoot, "summary.html"), "utf8");
    assert(!summaryHtml.includes(SESSION_SECRET), "summary.html leaked the session secret");
    const dashboardHtml = await renderDashboardHtml({ projectRoot: cwd, run: result.runId });
    assert(!dashboardHtml.includes(SESSION_SECRET), "dashboard HTML leaked the session secret");
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});
