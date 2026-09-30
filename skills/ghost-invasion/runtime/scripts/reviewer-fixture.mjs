// Disposable synthetic fixture exercising the real browser runner, findings, traces,
// reset, deterministic replay, and explicit local browser-origin authorization.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertLocalRunAllowed } from "../core/dist/local-boundary.js";
const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../core/dist/ghost-invasion.js", import.meta.url));
async function cli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
    maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(stdout);
}
function createBuggyProjectServer() {
  let fixed = false;
  let resets = 0;
  let sequence = 0;
  let projects = [
    { id: "seed-a", ownerId: "user-a", name: "Seed A", notes: "", createdAt: "2026-05-30T10:00:00.000Z" }
  ];

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/reset") {
      resets += 1;
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
      projects.push({
        id: `project-${sequence}`,
        ownerId: "user-a",
        name: String(body.name ?? ""),
        notes: "",
        createdAt: new Date().toISOString()
      });
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
                <label>Project name <input aria-label="Project name" name="name" /></label>
                <button type="submit">Create</button>
              </form>
            </main>
            <script>
              const form = document.querySelector('form');
              let pending = false;
              form.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (${fixed} && pending) return;
                pending = true;
                const name = new FormData(form).get('name');
                await fetch('/api/projects', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name })
                });
                setTimeout(() => { pending = false; }, 250);
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
    fix() { fixed = true; },
    state() { return { projects: JSON.parse(JSON.stringify(projects)), resets }; },
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

async function writePlan(projectRoot, baseUrl, sessions = 1, expectedInserted = 1, overrides = {}) {
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
      egress: { mode: "container-firewall", proven: false, allowlist: ["localhost", "127.0.0.1"] },
      liveSecrets: [],
      mocksApplied: [],
      dataReset: { strategy: "user-command", isolation: "user-reset", destructiveAllowed: true },
      approvalRequired: false
    },
    swarm: {
      browserConcurrency: 2,
      browserWaves: Math.ceil(sessions / 2),
      totalBrowserSessions: sessions,
      apiTier: overrides.apiTier ?? { enabled: false, engine: "fetch", rps: 0, targets: [] },
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
            expectInserted: expectedInserted,
            label: "Duplicate project created on double-click"
          }
        ],
        abandon: []
      }
    ],
    surfaceHash: "sha256:test",
    approvedPlanHash: null
  };
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return planPath;
}


const outputRoot = process.argv[2] ? resolve(process.argv[2]) : tmpdir();
await mkdir(outputRoot, { recursive: true });
const cwd = await mkdtemp(join(outputRoot, "ghost-review-fixture-"));
const app = createBuggyProjectServer();
const baseUrl = await app.start();
const receipt = { fixtureVersion: 1, baseUrl, seed: 1337, root: cwd, egressEvidence: "Browser-origin request and redirect guard; WebSockets and service workers blocked. No OS/container isolation claimed.", runs: [], checks: {} };
try {
  const planPath = await writePlan(cwd, baseUrl);
  let plan = JSON.parse(await readFile(planPath, "utf8"));
  const gate = (overrides = {}) => assertLocalRunAllowed({ projectRoot: cwd, loadedPlan: plan, effectivePlan: plan, baseUrl, budgetUsd: 0, sessions: 1, workers: 1, reproductionBudget: 0, env: {}, ...overrides });
  await assert.rejects(gate(), /authorize-local/);
  await cli(["authorize-local", "--cwd", cwd, "--plan", planPath, "--reset-path", "/api/reset", "--max-sessions", "1", "--max-workers", "1", "--confirm-disposable-target"]);
  plan = JSON.parse(await readFile(planPath, "utf8"));
  await assert.rejects(gate({ loadedPlan: { ...plan, seed: 999 } }), /approved plan/);
  await assert.rejects(gate({ budgetUsd: 1 }), /budget 0/);
  await assert.rejects(gate({ sessions: 2 }), /limit/);
  await assert.rejects(gate({ runReset: false }), /resets on/);
  await assert.rejects(gate({ baseUrl: "https://example.com" }), /127.0.0.1/);
  receipt.checks.cli = "actual authorize-local and run CLI commands executed in child processes with synthetic-only environment";
  receipt.checks.authorization = "missing approval, plan tampering, nonzero budget, excessive sessions, reset skip and external target blocked";
  for (const label of ["known-fault", "replay", "fixed-control"]) {
    if (label === "fixed-control") app.fix();
    const result = await cli(["run", "--cwd", cwd, "--plan", planPath, "--local-only", "--quick", "--workers", "1", "--sessions", "1", "--seed", "1337", "--budget-usd", "0", "--repro-budget", "0"]);
    const report = JSON.parse(await readFile(join(result.runRoot, "report.json"), "utf8"));
    assert.equal(result.cost.actualUsd, 0);
    assert.equal(result.cost.budgetUsd, 0);
    assert.equal(result.totals.orphanedChromiumProcesses, 0);
    assert.equal(app.state().projects.length, 1);
    const expectedFailures = label === "fixed-control" ? 0 : 1;
    assert.equal(result.totals.failed, expectedFailures);
    assert.equal(result.pristine.failed, 0);
    if (expectedFailures) {
      const finding = report.findings.find(f => f.invariant === "mutation.idempotent-create");
      assert(finding);
      assert(finding.evidence.some(p => p.endsWith("trace.zip")));
      for (const p of finding.evidence) await access(join(result.runRoot, p));
      assert(finding.actual.includes("2"));
    }
    receipt.runs.push({ label, runId: result.runId, runRoot: result.runRoot, failed: result.totals.failed, pristineFailed: result.pristine.failed, findings: report.findings.map(f => ({ id: f.id, invariant: f.invariant, actual: f.actual })), actualUsd: result.cost.actualUsd });
  }
  assert.equal(app.state().resets, 6);
  assert.deepEqual(receipt.runs[0].findings, receipt.runs[1].findings);
  await assert.rejects(access(join(cwd, "AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(access(join(cwd, "CLAUDE.md")), { code: "ENOENT" });
  receipt.checks.reset = "six real HTTP resets; initial single seeded record restored after each run";
  receipt.checks.replay = "same seed reproduced same known duplicate-write fault; fixed control passed";
  receipt.checks.memory = "no AGENTS.md or CLAUDE.md created";
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = error.stack;
  process.exitCode = 1;
} finally {
  await app.stop();
  await assert.rejects(fetch(baseUrl));
  receipt.checks.serverStopped = true;
  await writeFile(join(cwd, "review-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ status: receipt.status, receipt: join(cwd, "review-receipt.json"), checks: receipt.checks, error: receipt.error }, null, 2));
}
