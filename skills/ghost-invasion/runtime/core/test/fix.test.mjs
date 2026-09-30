import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rerunFindingFix, writeSuggestedFixes } from "../dist/fix.js";
import { runSwarm } from "../dist/swarm.js";
import { planHash } from "../dist/planner.js";

function createFixableProjectServer() {
  let fixed = false;
  let sequence = 0;
  const inFlightCreates = new Set();
  let projects = [
    { id: "seed-a", ownerId: "user-a", name: "Seed A", notes: "", createdAt: "2026-05-30T10:00:00.000Z" }
  ];

  const reset = () => {
    sequence = 0;
    inFlightCreates.clear();
    projects = [{ id: "seed-a", ownerId: "user-a", name: "Seed A", notes: "", createdAt: "2026-05-30T10:00:00.000Z" }];
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/projects") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ projects }));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const name = String(body.name ?? "");
      if (fixed && inFlightCreates.has(name)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ project: projects.find((project) => project.name === name) }));
        return;
      }
      if (fixed) inFlightCreates.add(name);
      await new Promise((resolve) => setTimeout(resolve, fixed ? 50 : 0));
      sequence += 1;
      projects.push({
        id: `project-${sequence}`,
        ownerId: "user-a",
        name,
        notes: "",
        createdAt: new Date().toISOString()
      });
      if (fixed) setTimeout(() => inFlightCreates.delete(name), 100);
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ project: projects.at(-1) }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/projects/new") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html>
        <html>
          <body>
            <main>
              <h1>Create project</h1>
              <form>
                <label>Project name <input aria-label="Project name" name="name" required /></label>
                <button type="submit">Create</button>
              </form>
            </main>
            <script>
              const form = document.querySelector('form');
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                const name = new FormData(form).get('name');
                fetch('/api/projects', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name })
                });
              });
            </script>
          </body>
        </html>`);
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
    applyFix() {
      fixed = true;
      reset();
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function writePlan(projectRoot, baseUrl) {
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
        id: "chaotic-user",
        archetype: "chaotic_user",
        role: { name: "member", authStrategy: "none", stateRef: null },
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
        appliesToPersonas: ["chaotic-user"],
        invariantsTested: ["mutation.idempotent-create"],
        pristineRequired: true,
        anchors: { routes: ["/projects/new"], mutations: ["POST /api/projects"], surfaceHash: "sha256:test" },
        idealPath: ["goto:/projects/new", "fill:name=Launch plan", "clickRole:button:Create"],
        steps: [
          { type: "goto", url: "/projects/new" },
          { type: "fill", selector: "role=textbox[name=/project name/i]", value: "Launch plan" },
          { type: "dbSnapshot", id: "before", table: "projects", url: "/api/projects" },
          { type: "doubleSubmit", role: "button", name: "Create", gapMs: 20, cause: "ghost-injected" },
          { type: "wait", ms: 150 },
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

  // Register a trusted reset boundary so the mutating rerun clears the pre-run safety gate.
  const configDir = join(projectRoot, ".ghost", "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "reset.json"),
    `${JSON.stringify(
      {
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
      },
      null,
      2
    )}\n`
  );
  return planPath;
}

test("fix writes propose-only suggestions and rerun turns green only after fresh proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-fix-"));
  const app = createFixableProjectServer();
  const baseUrl = await app.start();
  try {
    const planPath = await writePlan(cwd, baseUrl);
    const original = await runSwarm({ projectRoot: cwd, planPath, workers: 1, runReset: false });
    assert.equal(original.totals.failed, 1);

    const suggestions = await writeSuggestedFixes({ projectRoot: cwd, run: original.runId });
    assert.deepEqual(suggestions.includedFindingIds, ["F-001"]);
    const markdown = await readFile(suggestions.path, "utf8");
    assert(markdown.includes("Propose-only repair pass"));
    assert(markdown.includes("ghost-invasion fix --rerun F-001"));
    assert(markdown.includes("```diff"));

    app.applyFix();
    const rerun = await rerunFindingFix("F-001", { projectRoot: cwd, run: original.runId, planPath, runReset: false });
    assert.equal(rerun.status, "green");
    assert.equal(rerun.journeyId, "double-click-save");
    assert.equal(rerun.seed, 1337);
    assert(rerun.freshReportJson);
    assert(rerun.message.includes("fresh artifacts"));

    const proof = JSON.parse(await readFile(rerun.proofPath, "utf8"));
    assert.equal(proof.guardrail, "green requires a fresh passing targeted run with no matching finding");
  } finally {
    await app.stop();
    await rm(cwd, { force: true, recursive: true });
  }
});
