import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportExample } from "../dist/examples/schema-examples.js";
import { mergeShardReports, renderDemoReport, renderReportArtifactsFromRun, replayFinding } from "../dist/reporter.js";

test("reporter renders markdown, html, repro steps, tests, and replay command", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-reporter-"));
  const runRoot = join(cwd, ".ghost", "runs", reportExample.runId);
  const tracePath = join(runRoot, "evidence", "chaotic.double-click-save.07", "trace.zip");
  await mkdir(join(runRoot, "evidence", "chaotic.double-click-save.07"), { recursive: true });
  await writeFile(tracePath, "trace placeholder");
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(reportExample, null, 2)}\n`);

  try {
    const artifacts = await renderReportArtifactsFromRun(runRoot);
    assert.equal(artifacts.reportMarkdown, join(runRoot, "report.md"));
    assert.equal(artifacts.summaryHtml, join(runRoot, "summary.html"));
    assert.equal(artifacts.reproductionSteps.length, 1);
    assert.equal(artifacts.generatedTests.length, 1);

    const markdown = await readFile(artifacts.reportMarkdown, "utf8");
    assert(markdown.includes("START HERE"));
    assert(markdown.includes("Cost: estimated"));
    assert(markdown.includes("What a real user did:"));
    assert(markdown.includes("npx playwright show-trace"));

    const html = await readFile(artifacts.summaryHtml, "utf8");
    assert(html.includes("Ghost Invasion Summary"));
    assert(html.includes("<strong>Cost</strong>"));
    assert(html.includes("Open trace.zip with Playwright"));

    const replay = await replayFinding({ projectRoot: cwd, findingId: "F-001", printOnly: true });
    assert.equal(replay.artifactPath, tracePath);
    assert.deepEqual(replay.openCommand.slice(0, 3), ["npx", "playwright", "show-trace"]);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("rendered report and summary mask live env-key signals to a boolean phrase", async () => {
  // S-055/S-030: even if a live env-secret value reaches the safety block, no renderer
  // may serialize the value — only the masked "live-key signals present" phrase.
  const LIVE_SECRET_VALUE = "sk_live_RENDER_LEAK_CANARY_00998877";
  const cwd = await mkdtemp(join(tmpdir(), "ghost-reporter-"));
  const report = JSON.parse(JSON.stringify(reportExample));
  report.safety.dangerousEnvKeysDetected = [LIVE_SECRET_VALUE];
  const runRoot = join(cwd, ".ghost", "runs", report.runId);
  await mkdir(join(runRoot, "evidence", "chaotic.double-click-save.07"), { recursive: true });
  await writeFile(join(runRoot, "evidence", "chaotic.double-click-save.07", "trace.zip"), "trace placeholder");
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  try {
    const artifacts = await renderReportArtifactsFromRun(runRoot);
    const markdown = await readFile(artifacts.reportMarkdown, "utf8");
    const html = await readFile(artifacts.summaryHtml, "utf8");

    assert(!markdown.includes(LIVE_SECRET_VALUE), "report.md leaked a live env-key value");
    assert(!html.includes(LIVE_SECRET_VALUE), "summary.html leaked a live env-key value");
    assert(markdown.includes("masked live-key signals present"));
    assert(html.includes("masked live-key signals present"));
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("an unclean run never renders a clean headline and differs from a clean run (S-038)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-reporter-"));
  try {
    // Baseline: a clean run with zero confirmed bugs.
    const cleanReport = JSON.parse(JSON.stringify(reportExample));
    cleanReport.totals = { findings: 0, critical: 0, confirmedBugs: 0, needsHumanReview: 0, falsePositivesSuppressed: 0 };
    cleanReport.findings = [];
    cleanReport.runStatus = { state: "completed", egressProven: true, quarantined: false, clean: true };
    const cleanMarkdown = await renderMarkdownTo(cwd, "clean-run", cleanReport);
    assert(cleanMarkdown.includes("No confirmed bugs in this run."));

    const scenarios = [
      { id: "circuit-broken", runStatus: { state: "circuit-breaker", egressProven: true, quarantined: false, clean: false }, expect: /ABORTED by circuit breaker/i },
      { id: "dry-run", runStatus: { state: "dry-run", egressProven: true, quarantined: false, clean: false }, expect: /DRY RUN/i },
      { id: "egress-unproven", runStatus: { state: "completed", egressProven: false, quarantined: false, clean: false }, expect: /EGRESS NOT PROVEN/i },
      { id: "quarantined", runStatus: { state: "completed", egressProven: true, quarantined: true, clean: false }, expect: /QUARANTINED/i }
    ];

    for (const scenario of scenarios) {
      const report = JSON.parse(JSON.stringify(cleanReport));
      report.runStatus = scenario.runStatus;
      const markdown = await renderMarkdownTo(cwd, scenario.id, report);
      assert.match(markdown, scenario.expect, `${scenario.id} headline must fail loud`);
      assert.notEqual(
        cleanMarkdown.split("## Verdict:")[1].split("\n")[0],
        markdown.split("## Verdict:")[1].split("\n")[0],
        `${scenario.id} headline must differ from a clean run`
      );

      const html = await readFile(join(cwd, ".ghost", "runs", scenario.id, "summary.html"), "utf8");
      assert.match(html, scenario.expect, `${scenario.id} summary.html must fail loud`);
    }
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

async function renderMarkdownTo(cwd, runId, report) {
  const runRoot = join(cwd, ".ghost", "runs", runId);
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify({ ...report, runId }, null, 2)}\n`);
  const artifacts = await renderReportArtifactsFromRun(runRoot);
  return readFile(artifacts.reportMarkdown, "utf8");
}

test("demo report renders committed fixtures without a target server", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-reporter-"));
  try {
    const result = await renderDemoReport({ projectRoot: cwd });
    assert.equal(result.demoReport, true);

    const report = JSON.parse(await readFile(result.reportJson, "utf8"));
    assert.equal(report.runId, "demo-report");
    assert.equal(report.cost.actualUsd, 0);
    assert.equal(report.cost.withinBudget, true);
    // The demo report.json itself must carry the synthetic marker so a live
    // dashboard pointed at this run can render the synthetic banner (S-049).
    assert.equal(report.synthetic, true);

    const markdown = await readFile(result.artifacts.reportMarkdown, "utf8");
    assert(markdown.includes("Ghost Invasion Report - demo-report"));
    assert(markdown.includes("Cost: estimated"));
    const html = await readFile(result.artifacts.summaryHtml, "utf8");
    assert(html.includes("Ghost Invasion Summary"));
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("mergeShardReports combines completed shard reports into one merged report", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-reporter-"));
  try {
    await writeShardRun(cwd, "run-a.shard-1-of-2", 1, "Shard one duplicate create");
    await writeShardRun(cwd, "run-b.shard-2-of-2", 2, "Shard two duplicate create");

    const result = await mergeShardReports({
      projectRoot: cwd,
      shards: ["run-a.shard-1-of-2", "run-b.shard-2-of-2"],
      runId: "merged-run"
    });

    const report = JSON.parse(await readFile(result.reportJson, "utf8"));
    assert.equal(report.runId, "merged-run");
    assert.equal(report.invasion.browserSessions, 2);
    assert.equal(report.totals.findings, 2);
    assert.deepEqual(
      [...report.findings.map((finding) => finding.id)].sort(),
      ["F-001", "F-002"]
    );
    // Ids are minted by content order, not shard input order, so locate each shard's
    // finding by its content-stable `merged-from` signal rather than by position (S-037).
    const fromShardOne = report.findings.find((finding) =>
      finding.signals.includes("merged-from:run-a.shard-1-of-2:F-001")
    );
    const fromShardTwo = report.findings.find((finding) =>
      finding.signals.includes("merged-from:run-b.shard-2-of-2:F-001")
    );
    assert.ok(fromShardOne, "merged report keeps shard-one provenance");
    assert.ok(fromShardTwo, "merged report keeps shard-two provenance");
    assert(fromShardOne.evidence[0].includes("../run-a.shard-1-of-2/evidence/"));

    const summary = JSON.parse(await readFile(result.summaryPath, "utf8"));
    assert.deepEqual(
      summary.shardMerge.shards.map((shard) => shard.index),
      [1, 2]
    );
    assert.equal(summary.totals.failed, 2);
    assert.equal(result.artifacts.reproductionSteps.length, 2);
    assert.equal(result.artifacts.generatedTests.length, 2);

    const markdown = await readFile(join(result.runRoot, "report.md"), "utf8");
    assert(markdown.includes("F-001"));
    assert(markdown.includes("F-002"));
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("mergeShardReports mints ids from content priority, not shard input order (S-037)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-reporter-"));
  try {
    // Shard one carries the LOW-severity finding, shard two the CRITICAL one. The merge
    // must rank by report priority (most severe = F-001) regardless of which shard it came
    // from — a positional renumber would mislabel the low-severity finding as F-001.
    await writeShardRun(cwd, "run-a.shard-1-of-2", 1, "Low severity shard-one finding", { severity: "low" });
    await writeShardRun(cwd, "run-b.shard-2-of-2", 2, "Critical severity shard-two finding", { severity: "critical" });

    const result = await mergeShardReports({
      projectRoot: cwd,
      shards: ["run-a.shard-1-of-2", "run-b.shard-2-of-2"],
      runId: "merged-priority"
    });

    const report = JSON.parse(await readFile(result.reportJson, "utf8"));
    const critical = report.findings.find((finding) => finding.severity === "critical");
    const low = report.findings.find((finding) => finding.severity === "low");
    assert.equal(critical.id, "F-001", "the critical finding must be the headline F-001");
    assert.equal(low.id, "F-002", "the low-severity finding must rank below the critical one");
    // The id maps to content, so the headline id carries shard-two's provenance.
    assert(critical.signals.includes("merged-from:run-b.shard-2-of-2:F-001"));
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

async function writeShardRun(cwd, runId, index, title, findingOverrides = {}) {
  const runRoot = join(cwd, ".ghost", "runs", runId);
  const evidenceDir = join(runRoot, "evidence", `drone-${index}.trace`);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "trace.zip"), "trace placeholder");
  await writeFile(join(evidenceDir, "db-diff.json"), JSON.stringify({ table: "projects", expectedInserted: 1, actualInserted: 2, pass: false }));
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ runId, type: "swarm-complete" })}\n`);

  const finding = {
    ...reportExample.findings[0],
    id: "F-001",
    title,
    evidence: [`evidence/drone-${index}.trace/trace.zip`, `evidence/drone-${index}.trace/db-diff.json`],
    reproSteps: "reproduction-steps/F-001.md",
    generatedTest: "generated-tests/F-001.spec.ts",
    ...findingOverrides
  };
  const report = {
    ...reportExample,
    runId,
    invasion: { ...reportExample.invasion, browserSessions: 1 },
    scale: { headline: "1 browser user in 1 wave + 0 API hits across 0 endpoints" },
    totals: { findings: 1, critical: 1, confirmedBugs: 1, needsHumanReview: 0, falsePositivesSuppressed: 0 },
    findings: [finding]
  };
  const summary = {
    runId,
    runRoot,
    status: "completed",
    target: report.target.url,
    scale: { browserSessions: 1, browserConcurrency: 1, browserWaves: 1, apiRequests: 0, apiEndpointsHit: 0 },
    shard: { index, total: 2, selectedSessions: 1, totalSessions: 2 },
    totals: {
      succeeded: 0,
      failed: 1,
      tracedFailures: 1,
      traceSkippedByCap: 0,
      status5xx: 0,
      status429: 0,
      orphanedChromiumProcesses: 0
    },
    evidence: { events: join(runRoot, "events.jsonl"), traceReservations: { [`fingerprint-${index}`]: 1 } },
    pristine: { total: 1, passed: 1, failed: 0 },
    cost: report.cost,
    failures: [
      {
        droneId: `drone-${index}`,
        journeyId: "double-click-save",
        personaId: "chaotic-user",
        seed: 1337 + index,
        message: title,
        traced: true,
        fingerprint: `fingerprint-${index}`
      }
    ]
  };
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(runRoot, "swarm-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}
