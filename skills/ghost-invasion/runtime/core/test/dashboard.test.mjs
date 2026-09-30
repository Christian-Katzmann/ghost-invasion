import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboardSnapshot, renderDashboardHtml, startDashboardServer } from "../dist/dashboard.js";
import { reportExample } from "../dist/examples/schema-examples.js";

test("dashboard snapshot reads live artifacts without requiring report completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-dashboard-"));
  const runRoot = join(cwd, ".ghost", "runs", "live-run");
  await mkdir(runRoot, { recursive: true });
  await writeFile(
    join(runRoot, "events.jsonl"),
    [
      { runId: "live-run", type: "drone-start", droneId: "drone-1", ts: "2026-05-31T18:00:00.000Z" },
      { runId: "live-run", type: "pristine-sentinel", journeyId: "happy-path", ok: false, ts: "2026-05-31T18:00:01.000Z" },
      { runId: "live-run", type: "drone-failed", droneId: "drone-1", ts: "2026-05-31T18:00:02.000Z" }
    ].map((event) => JSON.stringify(event)).join("\n") + "\n"
  );

  try {
    const snapshot = await buildDashboardSnapshot({ projectRoot: cwd, run: "live-run" });
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.runId, "live-run");
    assert.equal(snapshot.pristine.quarantined, true);
    assert.equal(snapshot.progress.started, 1);
    assert.equal(snapshot.progress.failed, 1);
    assert.equal(snapshot.findings.length, 0);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("dashboard renders completed findings and serves only read-only endpoints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-dashboard-"));
  const runRoot = join(cwd, ".ghost", "runs", reportExample.runId);
  const tracePath = join(runRoot, "evidence", "chaotic.double-click-save.07", "trace.zip");
  await mkdir(join(runRoot, "evidence", "chaotic.double-click-save.07"), { recursive: true });
  await writeFile(tracePath, "trace placeholder");
  await writeFile(join(runRoot, "report.md"), "# report\n");
  await writeFile(join(runRoot, "summary.html"), "<html></html>\n");
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ runId: reportExample.runId, type: "swarm-complete" })}\n`);
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(reportExample, null, 2)}\n`);
  await writeFile(
    join(runRoot, "swarm-summary.json"),
    `${JSON.stringify(
      {
        runId: reportExample.runId,
        runRoot,
        status: "completed",
        target: reportExample.target.url,
        scale: { browserSessions: 3, browserConcurrency: 2, browserWaves: 2, apiRequests: 0, apiEndpointsHit: 0 },
        totals: {
          succeeded: 2,
          failed: 1,
          tracedFailures: 1,
          traceSkippedByCap: 0,
          status5xx: 0,
          status429: 0,
          orphanedChromiumProcesses: 0
        },
        evidence: { events: join(runRoot, "events.jsonl"), traceReservations: {} },
        pristine: { total: 1, passed: 1, failed: 0 },
        cost: reportExample.cost,
        failures: []
      },
      null,
      2
    )}\n`
  );

  let dashboard;
  try {
    const snapshot = await buildDashboardSnapshot({ projectRoot: cwd });
    assert.equal(snapshot.status, "clean");
    assert.equal(snapshot.clean, true);
    assert.equal(snapshot.findings.length, 1);
    assert.equal(snapshot.findings[0].replayKind, "trace");

    const html = await renderDashboardHtml({ projectRoot: cwd, run: reportExample.runId });
    assert(html.includes("Ghost Invasion Dashboard"));
    assert(html.includes("__GHOST_DASHBOARD__"));

    dashboard = await startDashboardServer({ projectRoot: cwd, run: reportExample.runId, port: 0 });
    const api = await fetch(new URL("/api/run", dashboard.url));
    assert.equal(api.status, 200);
    assert.equal(api.headers.get("x-ghost-dashboard-read-only"), "true");
    const body = await api.json();
    assert.equal(body.readOnly, true);
    assert.equal(body.findings[0].id, "F-001");

    const artifact = await fetch(new URL(`/artifact?path=${encodeURIComponent("evidence/chaotic.double-click-save.07/trace.zip")}`, dashboard.url));
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), "trace placeholder");

    const writeAttempt = await fetch(new URL("/api/run", dashboard.url), { method: "POST" });
    assert.equal(writeAttempt.status, 405);

    const traversal = await fetch(new URL(`/artifact?path=${encodeURIComponent("../outside.txt")}`, dashboard.url));
    assert.equal(traversal.status, 403);
  } finally {
    if (dashboard) await dashboard.close();
    await rm(cwd, { force: true, recursive: true });
  }
});

test("dashboard never renders an incomplete or unproven run as clean (S-038)", async () => {
  const scenarios = [
    { id: "circuit-broken", runStatus: { state: "circuit-breaker", egressProven: true, quarantined: false, clean: false }, status: "circuit-breaker" },
    { id: "egress-unproven", runStatus: { state: "completed", egressProven: false, quarantined: false, clean: false }, status: "egress-unproven" },
    { id: "quarantined", runStatus: { state: "completed", egressProven: true, quarantined: true, clean: false }, status: "quarantined" }
  ];

  for (const scenario of scenarios) {
    const cwd = await mkdtemp(join(tmpdir(), "ghost-dashboard-"));
    const runRoot = join(cwd, ".ghost", "runs", scenario.id);
    await mkdir(runRoot, { recursive: true });
    const report = JSON.parse(JSON.stringify(reportExample));
    report.runId = scenario.id;
    report.runStatus = scenario.runStatus;
    await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ runId: scenario.id, type: "swarm-complete" })}\n`);

    try {
      const snapshot = await buildDashboardSnapshot({ projectRoot: cwd, run: scenario.id });
      assert.equal(snapshot.clean, false, `${scenario.id} must not be clean`);
      assert.notEqual(snapshot.status, "clean", `${scenario.id} status must not read clean`);
      assert.equal(snapshot.status, scenario.status);

      const html = await renderDashboardHtml({ projectRoot: cwd, run: scenario.id });
      assert(html.includes('"clean":false') || html.includes('"clean": false'), `${scenario.id} embedded snapshot must mark clean false`);
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  }
});

test("dashboard surfaces a dry-run summary as non-green (S-038)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-dashboard-"));
  const runRoot = join(cwd, ".ghost", "runs", "dry");
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ runId: "dry", type: "drone-start" })}\n`);
  await writeFile(
    join(runRoot, "swarm-summary.json"),
    `${JSON.stringify({ runId: "dry", runRoot, status: "dry-run", target: "http://127.0.0.1:5173", scale: { browserSessions: 0, browserConcurrency: 0, browserWaves: 0, apiRequests: 0, apiEndpointsHit: 0 }, totals: { succeeded: 0, failed: 0, tracedFailures: 0, traceSkippedByCap: 0, status5xx: 0, status429: 0, orphanedChromiumProcesses: 0 }, evidence: { events: join(runRoot, "events.jsonl"), traceReservations: {} }, pristine: { total: 0, passed: 0, failed: 0 }, cost: reportExample.cost, failures: [] }, null, 2)}\n`
  );

  try {
    const snapshot = await buildDashboardSnapshot({ projectRoot: cwd, run: "dry" });
    assert.equal(snapshot.status, "dry-run");
    assert.equal(snapshot.clean, false);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("dashboard renders a synthetic banner for a demo-report-derived run (S-049)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-dashboard-"));
  const runRoot = join(cwd, ".ghost", "runs", "demo-derived");
  await mkdir(runRoot, { recursive: true });
  const report = JSON.parse(JSON.stringify(reportExample));
  report.runId = "demo-derived";
  report.synthetic = true;
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ runId: "demo-derived", type: "swarm-complete" })}\n`);

  try {
    const snapshot = await buildDashboardSnapshot({ projectRoot: cwd, run: "demo-derived" });
    assert.equal(snapshot.synthetic, true, "a synthetic report.json must mark the snapshot synthetic");

    const html = await renderDashboardHtml({ projectRoot: cwd, run: "demo-derived" });
    assert(
      html.includes('"synthetic":true') || html.includes('"synthetic": true'),
      "embedded snapshot must carry the synthetic flag"
    );
    assert(html.includes("synthetic-banner"), "dashboard must render a synthetic banner element");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("dashboard does not mark a real run as synthetic (S-049)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-dashboard-"));
  const runRoot = join(cwd, ".ghost", "runs", "real");
  await mkdir(runRoot, { recursive: true });
  const report = JSON.parse(JSON.stringify(reportExample));
  report.runId = "real";
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ runId: "real", type: "swarm-complete" })}\n`);

  try {
    const snapshot = await buildDashboardSnapshot({ projectRoot: cwd, run: "real" });
    assert.equal(snapshot.synthetic, false);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("dashboard refuses non-loopback binds", async () => {
  await assert.rejects(startDashboardServer({ host: "0.0.0.0", port: 0 }), /loopback-only/);
});
