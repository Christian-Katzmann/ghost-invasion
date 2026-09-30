import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compareFindings } from "./classifier.js";
import { estimateRunCost, finalizeRunCost, mergeCostReports } from "./cost-model.js";
import { createRunId } from "./evidence.js";
import { reportExample } from "./examples/schema-examples.js";
import type { Finding } from "./schemas/finding.js";
import { deriveRunStatus, type ReportJson } from "./schemas/report.js";
import { severityCss, severityLabel } from "./severity-styles.js";
import type { SwarmRunResult } from "./swarm.js";

export interface ReportArtifacts {
  reportMarkdown: string;
  summaryHtml: string;
  reproductionSteps: string[];
  generatedTests: string[];
}

export interface ReplayResult {
  findingId: string;
  artifactPath: string;
  openCommand: string[];
}

export interface MergeShardReportsOptions {
  projectRoot: string;
  shards: string[];
  runId?: string;
}

export interface MergeShardReportsResult {
  runId: string;
  runRoot: string;
  shardRunRoots: string[];
  reportJson: string;
  summaryPath: string;
  artifacts: ReportArtifacts;
}

export interface DemoReportResult {
  command: "run";
  demoReport: true;
  runId: string;
  runRoot: string;
  reportJson: string;
  artifacts: ReportArtifacts;
}

const severityRank: Record<Finding["severity"], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1
};

export async function renderReportArtifacts(options: {
  report: ReportJson;
  runRoot: string;
  synthetic?: boolean;
}): Promise<ReportArtifacts> {
  const runRoot = resolve(options.runRoot);
  const synthetic = options.synthetic ?? false;
  const normalizedReport = ensureReportCost(options.report);
  const report = {
    ...normalizedReport,
    findings: rankFindings(normalizedReport.findings)
  };
  const reproductionDir = join(runRoot, "reproduction-steps");
  const generatedTestsDir = join(runRoot, "generated-tests");
  await mkdir(reproductionDir, { recursive: true });
  await mkdir(generatedTestsDir, { recursive: true });

  const reproductionSteps: string[] = [];
  const generatedTests: string[] = [];
  for (const finding of report.findings) {
    const reproPath = join(runRoot, finding.reproSteps);
    const testPath = join(runRoot, finding.generatedTest);
    await mkdir(dirname(reproPath), { recursive: true });
    await mkdir(dirname(testPath), { recursive: true });
    await writeFile(reproPath, renderReproductionSteps(report, finding), "utf8");
    await writeFile(testPath, renderGeneratedTest(report, finding), "utf8");
    reproductionSteps.push(reproPath);
    generatedTests.push(testPath);
  }

  const reportMarkdown = join(runRoot, "report.md");
  const summaryHtml = join(runRoot, "summary.html");
  await writeFile(reportMarkdown, renderMarkdownReport(report, synthetic), "utf8");
  await writeFile(summaryHtml, renderSummaryHtml(report, synthetic), "utf8");
  return { reportMarkdown, summaryHtml, reproductionSteps, generatedTests };
}

export async function renderReportArtifactsFromRun(runRoot: string): Promise<ReportArtifacts> {
  const reportPath = join(resolve(runRoot), "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as ReportJson;
  return renderReportArtifacts({ report, runRoot });
}

export async function renderDemoReport(options: { projectRoot: string; runId?: string }): Promise<DemoReportResult> {
  const projectRoot = resolve(options.projectRoot);
  const runId = options.runId ?? "demo-report";
  const runRoot = join(projectRoot, ".ghost", "runs", runId);
  const evidenceDir = join(runRoot, "evidence", "chaotic.double-click-save.07");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "trace.zip"), "demo trace placeholder\n", "utf8");
  await writeFile(
    join(evidenceDir, "db-diff.json"),
    `${JSON.stringify({ table: "projects", expectedInserted: 1, actualInserted: 2, pass: false }, null, 2)}\n`,
    "utf8"
  );
  // Stamp the synthetic marker into report.json itself so a live `dashboard --run`
  // pointed at this demo run renders the synthetic banner, not just `run --demo-report`
  // at render time (S-049).
  const report = { ...reportExample, runId, synthetic: true };
  const reportJson = join(runRoot, "report.json");
  await writeFile(reportJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const artifacts = await renderReportArtifacts({ report, runRoot, synthetic: true });
  return { command: "run", demoReport: true, runId, runRoot, reportJson, artifacts };
}

export async function mergeShardReports(options: MergeShardReportsOptions): Promise<MergeShardReportsResult> {
  if (options.shards.length < 2) {
    throw new Error("Shard merge requires at least two completed shard run roots.");
  }

  const projectRoot = resolve(options.projectRoot);
  const shards = await Promise.all(
    options.shards.map(async (shard) => {
      const runRoot = await resolveReportRunRoot(projectRoot, shard);
      const report = await readJson<ReportJson>(join(runRoot, "report.json"));
      const summary = await readJson<SwarmRunResult>(join(runRoot, "swarm-summary.json"));
      return { runRoot, report, summary };
    })
  );
  validateShardSummaries(shards);
  shards.sort((a, b) => a.summary.shard!.index - b.summary.shard!.index);

  const runId = options.runId ?? `${createRunId()}.shard-merge`;
  const runRoot = join(projectRoot, ".ghost", "runs", runId);
  await mkdir(runRoot, { recursive: true });

  const findings = mergeShardFindings(shards, runRoot);
  const firstReport = ensureReportCost(shards[0]!.report);
  const firstSummary = shards[0]!.summary;
  const report: ReportJson = {
    ...firstReport,
    runId,
    invasion: {
      ...firstReport.invasion,
      personas: Math.max(...shards.map((shard) => shard.report.invasion.personas)),
      journeys: Math.max(...shards.map((shard) => shard.report.invasion.journeys)),
      browserSessions: sum(shards, (shard) => shard.report.invasion.browserSessions),
      apiRequests: sum(shards, (shard) => shard.report.invasion.apiRequests),
      apiEndpointsHit: sum(shards, (shard) => shard.report.invasion.apiEndpointsHit)
    },
    scale: {
      headline: `${sum(shards, (shard) => shard.summary.scale.browserSessions)} browser users in ${plural(
        sum(shards, (shard) => shard.summary.scale.browserWaves),
        "wave",
        "waves"
      )} + ${sum(shards, (shard) => shard.summary.scale.apiRequests)} API hits across ${plural(
        sum(shards, (shard) => shard.summary.scale.apiEndpointsHit),
        "endpoint",
        "endpoints"
      )}`
    },
    runStatus: deriveRunStatus({
      state: mergedStatus(shards.map((shard) => shard.summary.status)),
      egressProven: shards.every((shard) => shard.report.runStatus?.egressProven ?? shard.report.safety.egress.proven),
      quarantined: shards.some((shard) => shard.report.runStatus?.quarantined ?? false),
      // Any degraded shard taints the merged run: the combined proof log is incomplete.
      degraded: shards.some((shard) => shard.report.runStatus?.degraded ?? false)
    }),
    totals: totalsFor(findings),
    cost: mergeCostReports(shards.map((shard) => ensureReportCost(shard.report).cost)),
    findings
  };

  const eventsPath = join(runRoot, "events.jsonl");
  await writeFile(eventsPath, renderShardMergeEvents(runId, shards), "utf8");
  const reportJson = join(runRoot, "report.json");
  await writeFile(reportJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const artifacts = await renderReportArtifacts({ report, runRoot });

  const summary = {
    runId,
    runRoot,
    status: mergedStatus(shards.map((shard) => shard.summary.status)),
    target: firstSummary.target,
    scale: {
      browserSessions: sum(shards, (shard) => shard.summary.scale.browserSessions),
      browserConcurrency: Math.max(...shards.map((shard) => shard.summary.scale.browserConcurrency)),
      browserWaves: sum(shards, (shard) => shard.summary.scale.browserWaves),
      apiRequests: sum(shards, (shard) => shard.summary.scale.apiRequests),
      apiEndpointsHit: sum(shards, (shard) => shard.summary.scale.apiEndpointsHit)
    },
    shardMerge: {
      total: shards[0]!.summary.shard!.total,
      shards: shards.map((shard) => ({
        index: shard.summary.shard!.index,
        runId: shard.report.runId,
        runRoot: shard.runRoot,
        selectedSessions: shard.summary.shard!.selectedSessions,
        findings: shard.report.findings.length
      }))
    },
    totals: {
      succeeded: sum(shards, (shard) => shard.summary.totals.succeeded),
      failed: sum(shards, (shard) => shard.summary.totals.failed),
      tracedFailures: sum(shards, (shard) => shard.summary.totals.tracedFailures),
      traceSkippedByCap: sum(shards, (shard) => shard.summary.totals.traceSkippedByCap),
      status5xx: sum(shards, (shard) => shard.summary.totals.status5xx),
      status429: sum(shards, (shard) => shard.summary.totals.status429),
      orphanedChromiumProcesses: sum(shards, (shard) => shard.summary.totals.orphanedChromiumProcesses)
    },
    evidence: {
      events: eventsPath,
      traceReservations: Object.fromEntries(
        shards.flatMap((shard) =>
          Object.entries(shard.summary.evidence.traceReservations).map(([fingerprint, count]) => [
            `${shard.report.runId}/${fingerprint}`,
            count
          ])
        )
      )
    },
    pristine: {
      total: sum(shards, (shard) => shard.summary.pristine.total),
      passed: sum(shards, (shard) => shard.summary.pristine.passed),
      failed: sum(shards, (shard) => shard.summary.pristine.failed)
    },
    failures: shards.flatMap((shard) => shard.summary.failures),
    classification: {
      reportJson,
      classifierSummary: "",
      reportMarkdown: artifacts.reportMarkdown,
      summaryHtml: artifacts.summaryHtml
    }
  };
  const summaryPath = join(runRoot, "swarm-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { runId, runRoot, shardRunRoots: shards.map((shard) => shard.runRoot), reportJson, summaryPath, artifacts };
}

export async function resolveReportRunRoot(projectRoot: string, run?: string): Promise<string> {
  if (run) {
    const candidate = isAbsolute(run) || run.includes("/") ? resolve(projectRoot, run) : join(projectRoot, ".ghost", "runs", run);
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isDirectory()) return candidate;
    if (basename(candidate) === "report.json") return dirname(candidate);
    throw new Error(`Run not found: ${candidate}`);
  }

  const runsRoot = join(projectRoot, ".ghost", "runs");
  const entries = (await readdir(runsRoot).catch(() => [])).sort();
  for (const entry of entries.reverse()) {
    const runRoot = join(runsRoot, entry);
    if (await exists(join(runRoot, "report.json"))) return runRoot;
  }
  throw new Error(`No report.json found under ${runsRoot}`);
}

function validateShardSummaries(shards: Array<{ runRoot: string; summary: SwarmRunResult }>): void {
  const specs = shards.map((shard) => shard.summary.shard);
  if (specs.some((spec) => !spec)) {
    throw new Error("Every merged run must be produced by ghost-invasion run --shard k/n.");
  }

  const total = specs[0]!.total;
  const indices = new Set<number>();
  for (const spec of specs) {
    if (spec!.total !== total) {
      throw new Error(`Cannot merge shard runs with different totals: expected ${total}, got ${spec!.total}.`);
    }
    if (indices.has(spec!.index)) {
      throw new Error(`Duplicate shard index ${spec!.index}/${total} in merge input.`);
    }
    indices.add(spec!.index);
  }
  if (indices.size !== total) {
    throw new Error(`Shard merge expected ${total} shard reports, received ${indices.size}.`);
  }
}

// A content key that is stable for the same finding no matter which shard surfaced it, so
// the merged id tracks the bug's identity rather than where it happened to land. Mirrors the
// single-run minting order (report priority, then a content tiebreak) — see classifier.ts.
function mergeFindingFingerprint(finding: Finding): string {
  const key = JSON.stringify([
    finding.invariant,
    finding.affected.surfaceId,
    finding.affected.route,
    finding.affected.api ?? "",
    finding.title,
    finding.expected,
    finding.actual
  ]);
  return createHash("sha256").update(key).digest("hex");
}

function mergeShardFindings(
  shards: Array<{ runRoot: string; report: ReportJson }>,
  mergedRunRoot: string
): Finding[] {
  // Mint merged ids from finding content, not positional shard order: collect every shard
  // finding, sort by report priority with a content-fingerprint tiebreak (id-neutralised so
  // the shard's local F-00n never decides), then number F-001.. over that stable order. The
  // same finding then keeps the same merged id regardless of shard layout or input order (S-037).
  const entries = shards.flatMap((shard) =>
    shard.report.findings.map((finding) => ({ shard, finding, fingerprint: mergeFindingFingerprint(finding) }))
  );
  entries.sort((a, b) => {
    const ranked = compareFindings({ ...a.finding, id: "" }, { ...b.finding, id: "" });
    if (ranked !== 0) return ranked;
    return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
  });

  return entries.map(({ shard, finding }, position) => {
    const id = `F-${String(position + 1).padStart(3, "0")}`;
    return {
      ...finding,
      id,
      evidence: finding.evidence.map((entry) => relativeShardPath(mergedRunRoot, shard.runRoot, entry)),
      reproSteps: `reproduction-steps/${id}.md`,
      generatedTest: `generated-tests/${id}.spec.ts`,
      minimalRepro: finding.minimalRepro ? relativeShardPath(mergedRunRoot, shard.runRoot, finding.minimalRepro) : null,
      signals: [...new Set([...finding.signals, `merged-from:${shard.report.runId}:${finding.id}`])]
    };
  });
}

function relativeShardPath(mergedRunRoot: string, shardRunRoot: string, shardRelativePath: string): string {
  return relative(mergedRunRoot, resolve(shardRunRoot, shardRelativePath)).replace(/\\/g, "/");
}

function totalsFor(findings: Finding[]): ReportJson["totals"] {
  return {
    findings: findings.length,
    critical: findings.filter((finding) => finding.severity === "critical").length,
    confirmedBugs: findings.filter((finding) => finding.category === "confirmed-bug").length,
    needsHumanReview: findings.filter((finding) => finding.category === "needs-human-review").length,
    falsePositivesSuppressed: findings.filter((finding) => finding.category !== "confirmed-bug").length
  };
}

function renderShardMergeEvents(
  runId: string,
  shards: Array<{ runRoot: string; report: ReportJson; summary: SwarmRunResult }>
): string {
  const now = new Date().toISOString();
  const events = [
    { ts: now, runId, type: "shard-merge-start", shards: shards.length },
    ...shards.map((shard) => ({
      ts: now,
      runId,
      type: "shard-merge-input",
      shardRunId: shard.report.runId,
      shardRunRoot: shard.runRoot,
      shard: shard.summary.shard
    })),
    { ts: now, runId, type: "shard-merge-complete", findings: sum(shards, (shard) => shard.report.findings.length) }
  ];
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function mergedStatus(statuses: SwarmRunResult["status"][]): SwarmRunResult["status"] {
  if (statuses.includes("circuit-breaker")) return "circuit-breaker";
  if (statuses.includes("dry-run")) return "dry-run";
  return "completed";
}

function sum<T>(items: T[], selector: (item: T) => number): number {
  return items.reduce((total, item) => total + selector(item), 0);
}

export async function replayFinding(options: {
  projectRoot: string;
  findingId: string;
  run?: string;
  printOnly?: boolean;
}): Promise<ReplayResult> {
  const runRoot = await resolveReportRunRoot(options.projectRoot, options.run);
  const report = JSON.parse(await readFile(join(runRoot, "report.json"), "utf8")) as ReportJson;
  const finding = report.findings.find((candidate) => candidate.id === options.findingId);
  if (!finding) {
    throw new Error(`Finding ${options.findingId} was not found in ${join(runRoot, "report.json")}`);
  }

  const artifact = await firstExistingArtifact(runRoot, finding, ["trace.zip", "video.webm", "network.har", "fail.png"]);
  if (!artifact) {
    throw new Error(`Finding ${finding.id} has no replayable artifact. Evidence listed: ${finding.evidence.join(", ")}`);
  }

  const openCommand = replayCommandFor(artifact);
  const result = { findingId: finding.id, artifactPath: artifact, openCommand };
  if (options.printOnly) return result;

  await spawnAndWait(openCommand[0]!, openCommand.slice(1));
  return result;
}

const SYNTHETIC_DEMO_NOTICE =
  "SYNTHETIC DEMO REPORT - generated by `run --demo-report`. No live invasion ran; these findings and artifacts are illustrative fixtures, not evidence from a real run.";

function renderMarkdownReport(report: ReportJson, synthetic = false): string {
  const folded = foldedDuplicateCount(report.findings);
  const flaky = report.totals.falsePositivesSuppressed;
  const lines = [
    `# Ghost Invasion Report - ${report.runId}`,
    "",
    ...(synthetic ? [`> ${SYNTHETIC_DEMO_NOTICE}`, ""] : []),
    "START HERE - prioritized findings from the evidence on disk.",
    "",
    `Scale: ${report.scale.headline}`,
    `Mode: ${report.invasion.mode} --pack ${report.invasion.pack}`,
    `Cost: estimated ${formatUsd(report.cost.estimatedUsd)}, actual ${formatUsd(report.cost.actualUsd)}${report.cost.budgetUsd === null ? "" : `, budget ${formatUsd(report.cost.budgetUsd)}`}`,
    `Target: ${report.target.url} (${report.target.stack})`,
    `Safety: ${safetyLine(report)}`,
    "",
    `## Verdict: ${verdictSummary(report)}`,
    ""
  ];

  for (const finding of report.findings) {
    lines.push(renderFindingMarkdown(report, finding), "");
  }

  lines.push(
    `Folded away: ${folded} near-identical failure(s) collapsed into the findings above. ${flaky} flaky or non-confirmed blip(s) are counted, not inflated.`,
    "Full machine data: report.json",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function renderFindingMarkdown(report: ReportJson, finding: Finding): string {
  const replay = replayLine(report, finding);
  const evidence = finding.evidence.map((entry) => `  - ${entry}`).join("\n");
  return [
    `## ${finding.severity.toUpperCase()} - ${finding.id} - ${finding.title}`,
    `Violates contract: ${finding.invariant}`,
    `Confidence: ${finding.confidence.toFixed(2)} (${humanCategory(finding.category)}) - reproduced across ${finding.reproducedAcross.personas} persona(s), ${finding.reproducedAcross.seeds} seed(s) - ${finding.reproductionRate} - pristine path ${finding.pristinePassed ? "PASSED" : "FAILED"}`,
    "",
    `What a real user did: ${realUserDid(finding)}`,
    `What should happen: ${finding.expected}`,
    `What actually happens: ${finding.actual}`,
    "",
    "Proof:",
    replay ? `  - Replay: ${replay}` : "  - Replay: no trace/video artifact listed",
    evidence ? evidence : "  - events.jsonl",
    `  - Steps to reproduce: ${finding.reproSteps}`,
    "",
    "Suggested fix:",
    `  - ${finding.suggestedFix}`,
    `  - Regression test written for you: ${finding.generatedTest}`
  ].join("\n");
}

function renderReproductionSteps(report: ReportJson, finding: Finding): string {
  const replay = replayLine(report, finding);
  return `${[
    `# ${finding.id} - ${finding.title}`,
    "",
    `Target: ${report.target.url}`,
    `Route: ${finding.affected.route}`,
    "",
    `1. Open ${finding.affected.route} as the affected user persona.`,
    `2. Recreate the behavior: ${realUserDid(finding)}`,
    `3. Expected result: ${finding.expected}`,
    `4. Actual result: ${finding.actual}`,
    replay ? `5. Open the replay: ${replay}` : "5. Open the evidence listed in report.json for this finding.",
    `6. Run the generated regression test: ${finding.generatedTest}`,
    ""
  ].join("\n")}\n`;
}

function renderGeneratedTest(report: ReportJson, finding: Finding): string {
  if (isIdempotentCreateFinding(finding)) {
    const route = jsonString(finding.affected.route);
    const apiPath = jsonString(apiPathForFinding(finding) ?? "/api/projects");
    const title = jsonString(`${finding.id} ${finding.title}`);
    return `${[
      'import { test, expect } from "@playwright/test";',
      "",
      `test(${title}, async ({ page, request }) => {`,
      `  const baseURL = process.env.GHOST_BASE_URL ?? ${jsonString(report.target.url)};`,
      `  const uniqueName = \`ghost-repro-\${Date.now()}\`;`,
      `  await page.goto(new URL(${route}, baseURL).toString());`,
      '  await page.getByRole("textbox").first().fill(uniqueName);',
      '  const submit = page.getByRole("button", { name: /create|save|submit/i }).first();',
      "  await submit.click();",
      "  await submit.click({ force: true });",
      "  await page.waitForTimeout(500);",
      "",
      `  const response = await request.get(new URL(${apiPath}, baseURL).toString());`,
      "  expect(response.ok()).toBeTruthy();",
      "  const body = await response.json();",
      "  const rows = Array.isArray(body) ? body : Array.isArray(body.projects) ? body.projects : [];",
      '  const matches = rows.filter((row) => row && typeof row === "object" && row.name === uniqueName);',
      "  expect(matches).toHaveLength(1);",
      "});",
      ""
    ].join("\n")}\n`;
  }

  const title = jsonString(`${finding.id} ${finding.title}`);
  return `${[
    'import { test, expect } from "@playwright/test";',
    "",
    `test(${title}, async ({ page }) => {`,
    `  const baseURL = process.env.GHOST_BASE_URL ?? ${jsonString(report.target.url)};`,
    `  await page.goto(new URL(${jsonString(finding.affected.route)}, baseURL).toString());`,
    `  await expect(page.locator("body")).toBeVisible();`,
    `  throw new Error(${jsonString(`Recreate ${finding.id} with the reproduction steps before turning this into a narrower assertion.`)});`,
    "});",
    ""
  ].join("\n")}\n`;
}

function renderSummaryHtml(report: ReportJson, synthetic = false): string {
  const findingsHtml = report.findings.map((finding) => renderFindingHtml(finding)).join("\n");
  return `${[
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `  <title>Ghost Invasion Summary - ${escapeHtml(report.runId)}</title>`,
    "  <style>",
    "    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f7f8; color: #171a1f; }",
    "    body { margin: 0; }",
    "    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }",
    "    header { border-bottom: 1px solid #d9dee5; padding-bottom: 18px; margin-bottom: 24px; }",
    "    h1 { font-size: 32px; line-height: 1.1; margin: 0 0 12px; letter-spacing: 0; }",
    "    h2 { font-size: 22px; margin: 0 0 12px; letter-spacing: 0; }",
    "    h3 { font-size: 16px; margin: 18px 0 6px; letter-spacing: 0; }",
    "    p { line-height: 1.55; }",
    "    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 18px 0 0; }",
    "    .meta div, article { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; }",
    "    .meta div { padding: 12px; }",
    "    article { margin: 16px 0; padding: 18px; box-shadow: 0 1px 2px rgba(10, 20, 30, 0.04); }",
    "    .finding-head { display: flex; gap: 12px; justify-content: space-between; align-items: start; flex-wrap: wrap; }",
    "    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; background: #eef2f6; color: #2d3642; }",
    "    .synthetic-banner { background: #2d1a00; color: #ffd9a0; border: 1px solid #b86a00; border-radius: 8px; padding: 12px 14px; margin: 0 0 18px; font-weight: 700; }",
    // Severity styling for all five levels comes from the shared table so a
    // low/info finding is never left unstyled and matches the dashboard (S-047).
    severityCss((severity) => `    .pill.${severity}`),
    "    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }",
    "    a { color: #075985; }",
    "    code { background: #edf1f5; border-radius: 4px; padding: 2px 5px; }",
    "    video, img { width: 100%; max-height: 380px; object-fit: contain; background: #111827; border-radius: 8px; }",
    "    ul { padding-left: 18px; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    synthetic ? `    <div class="synthetic-banner" role="alert">${escapeHtml(SYNTHETIC_DEMO_NOTICE)}</div>` : "",
    "    <header>",
    `      <p class="pill">START HERE</p>`,
    `      <h1>Ghost Invasion Summary</h1>`,
    `      <p>${escapeHtml(verdictSummary(report))}</p>`,
    '      <div class="meta">',
    `        <div><strong>Scale</strong><br />${escapeHtml(report.scale.headline)}</div>`,
    `        <div><strong>Cost</strong><br />estimated ${escapeHtml(formatUsd(report.cost.estimatedUsd))}<br />actual ${escapeHtml(formatUsd(report.cost.actualUsd))}${report.cost.budgetUsd === null ? "" : `<br />budget ${escapeHtml(formatUsd(report.cost.budgetUsd))}`}</div>`,
    `        <div><strong>Target</strong><br />${escapeHtml(report.target.url)}<br />${escapeHtml(report.target.stack)}</div>`,
    `        <div><strong>Safety</strong><br />${escapeHtml(safetyLine(report))}</div>`,
    `        <div><strong>Files</strong><br /><a href="report.md">report.md</a> | <a href="report.json">report.json</a></div>`,
    "      </div>",
    "    </header>",
    findingsHtml,
    `    <p>Folded away: ${foldedDuplicateCount(report.findings)} near-identical failure(s). ${report.totals.falsePositivesSuppressed} flaky or non-confirmed blip(s) counted.</p>`,
    "  </main>",
    "</body>",
    "</html>",
    ""
  ].join("\n")}`;
}

function renderFindingHtml(finding: Finding): string {
  const media = mediaHtml(finding);
  const evidence = finding.evidence
    .map((entry) => `<li><a href="${escapeAttribute(entry)}">${escapeHtml(entry)}</a></li>`)
    .join("");
  return `${[
    `    <article>`,
    `      <div class="finding-head">`,
    `        <div>`,
    `          <span class="pill ${escapeAttribute(finding.severity)}">${escapeHtml(severityLabel(finding.severity))}</span>`,
    `          <h2>${escapeHtml(finding.id)} - ${escapeHtml(finding.title)}</h2>`,
    `        </div>`,
    `        <span class="pill">${escapeHtml(humanCategory(finding.category))} ${finding.confidence.toFixed(2)}</span>`,
    `      </div>`,
    `      <p><strong>Contract:</strong> ${escapeHtml(finding.invariant)}<br /><strong>Breadth:</strong> ${finding.reproducedAcross.personas} persona(s), ${finding.reproducedAcross.seeds} seed(s), ${escapeHtml(finding.reproductionRate)}. Pristine path ${finding.pristinePassed ? "passed" : "failed"}.</p>`,
    `      <div class="grid">`,
    `        <section><h3>What a real user did</h3><p>${escapeHtml(realUserDid(finding))}</p></section>`,
    `        <section><h3>What should happen</h3><p>${escapeHtml(finding.expected)}</p></section>`,
    `        <section><h3>What actually happens</h3><p>${escapeHtml(finding.actual)}</p></section>`,
    `        <section><h3>Suggested fix</h3><p>${escapeHtml(finding.suggestedFix)}</p></section>`,
    `      </div>`,
    media ? `      <h3>Replay</h3>\n${media}` : "",
    `      <h3>Proof</h3>`,
    `      <ul>${evidence}<li><a href="${escapeAttribute(finding.reproSteps)}">${escapeHtml(finding.reproSteps)}</a></li><li><a href="${escapeAttribute(finding.generatedTest)}">${escapeHtml(finding.generatedTest)}</a></li></ul>`,
    `    </article>`
  ].join("\n")}`;
}

function mediaHtml(finding: Finding): string {
  // Describe what the media shows, not just the finding title, so assistive tech
  // conveys the evidence rather than re-reading the heading (S-048).
  const video = finding.evidence.find((entry) => entry.endsWith("video.webm"));
  if (video) return `      <video controls src="${escapeAttribute(video)}" aria-label="${escapeAttribute(`Session replay for ${finding.id}: ${finding.title}`)}"></video>`;
  const screenshot = finding.evidence.find((entry) => entry.endsWith(".png"));
  if (screenshot) return `      <img src="${escapeAttribute(screenshot)}" alt="${escapeAttribute(`Screenshot captured when ${finding.id} reproduced on ${finding.affected.route}`)}" />`;
  const trace = finding.evidence.find((entry) => entry.endsWith("trace.zip"));
  if (trace) return `      <p><a href="${escapeAttribute(trace)}">Open trace.zip with Playwright</a></p>`;
  return "";
}

function rankFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severity = severityRank[b.severity] - severityRank[a.severity];
    if (severity !== 0) return severity;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    const breadthA = a.reproducedAcross.personas + a.reproducedAcross.seeds;
    const breadthB = b.reproducedAcross.personas + b.reproducedAcross.seeds;
    if (breadthB !== breadthA) return breadthB - breadthA;
    // Stable tiebreak on the content-addressed id so display order never reorders
    // run-to-run for equal-rank findings (S-037).
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// A run can have zero confirmed bugs and still be untrustworthy: aborted by the
// circuit breaker, a dry run, egress never proven, or a quarantined pristine path.
// Surface that loudly so the headline never reads clean when the run was not (S-038).
function runStatusBanner(runStatus: ReportJson["runStatus"] | undefined): string | null {
  if (!runStatus || runStatus.clean) return null;
  const reasons: string[] = [];
  if (runStatus.state === "dry-run") reasons.push("DRY RUN - no live invasion executed; results are not authoritative");
  if (runStatus.state === "circuit-breaker") reasons.push("RUN ABORTED by circuit breaker - coverage is incomplete");
  if (runStatus.quarantined) reasons.push("QUARANTINED - a pristine-path sentinel failed; findings may be unreliable");
  if (!runStatus.egressProven) reasons.push("EGRESS NOT PROVEN - containment was not demonstrated for this run");
  if (runStatus.degraded) reasons.push("EVIDENCE INCOMPLETE - the evidence spine degraded mid-run; the proof log may be missing entries");
  return reasons.length > 0 ? reasons.join(" - ") : "RUN INCOMPLETE - this run is not clean";
}

function verdictSummary(report: ReportJson): string {
  const confirmed = report.totals.confirmedBugs;
  const needsEyes = report.totals.needsHumanReview;
  const findingsLine =
    confirmed === 0 && needsEyes === 0
      ? "No confirmed bugs in this run."
      : `${confirmed === 1 ? "1 confirmed bug" : `${confirmed} confirmed bugs`}, ${needsEyes === 1 ? "1 needs your eyes" : `${needsEyes} need your eyes`}.`;
  const banner = runStatusBanner(report.runStatus);
  return banner ? `${banner}. ${findingsLine}` : findingsLine;
}

function safetyLine(report: ReportJson): string {
  const mocks = report.safety.mockedServices.length > 0 ? `${report.safety.mockedServices.join(", ")} mocked` : "no service mocks";
  const egress = report.safety.egress.proven ? "egress trap proven" : "egress trap not proven";
  const dangerous = report.safety.dangerousEnvKeysDetected.length > 0 ? "masked live-key signals present" : "no live keys";
  return `${dangerous} - ${egress} (${report.safety.egress.mode}) - reset: ${report.safety.dataResetStrategy} - ${mocks}`;
}

function ensureReportCost(report: ReportJson): ReportJson {
  if (report.cost) return report;
  const shape = {
    mode: report.invasion.mode,
    browserSessions: report.invasion.browserSessions,
    apiRequests: report.invasion.apiRequests,
    reproductionAttempts: 0
  };
  return {
    ...report,
    cost: finalizeRunCost({
      estimate: estimateRunCost({ shape }),
      actual: shape
    })
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function realUserDid(finding: Finding): string {
  const lower = `${finding.title} ${finding.invariant}`.toLowerCase();
  if (lower.includes("double") || lower.includes("idempotent")) {
    return `Opened ${finding.affected.route}, entered new data, then clicked the submit button twice before the app settled.`;
  }
  if (lower.includes("tenant") || lower.includes("auth")) {
    return `Opened ${finding.affected.route} while authenticated and tried to view a resource that should belong to someone else.`;
  }
  if (lower.includes("spinner") || lower.includes("saving") || lower.includes("ux")) {
    return `Used ${finding.affected.route} under the recorded persona conditions and waited for the UI to recover.`;
  }
  return `Followed the failed journey on ${finding.affected.route}.`;
}

function replayLine(report: ReportJson, finding: Finding): string | null {
  const trace = finding.evidence.find((entry) => entry.endsWith("trace.zip"));
  if (trace) return `npx playwright show-trace .ghost/runs/${report.runId}/${trace}`;
  const video = finding.evidence.find((entry) => entry.endsWith("video.webm"));
  if (video) return `.ghost/runs/${report.runId}/${video}`;
  return null;
}

function foldedDuplicateCount(findings: Finding[]): number {
  return findings.reduce((sum, finding) => sum + Math.max(0, finding.occurrences - 1), 0);
}

function humanCategory(category: Finding["category"]): string {
  return category.replace(/-/g, " ");
}

function isIdempotentCreateFinding(finding: Finding): boolean {
  const text = `${finding.title} ${finding.invariant} ${finding.affected.api ?? ""}`.toLowerCase();
  return text.includes("idempotent") || text.includes("double-click") || text.includes("duplicate");
}

function apiPathForFinding(finding: Finding): string | null {
  const api = finding.affected.api;
  if (!api) return null;
  const match = api.match(/^(?:GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
  return match?.[1] ?? api;
}

async function firstExistingArtifact(runRoot: string, finding: Finding, suffixes: string[]): Promise<string | null> {
  for (const suffix of suffixes) {
    const relativePath = finding.evidence.find((entry) => entry.endsWith(suffix));
    if (!relativePath) continue;
    const absolutePath = join(runRoot, relativePath);
    if (await exists(absolutePath)) return absolutePath;
  }
  return null;
}

function replayCommandFor(path: string): string[] {
  if (path.endsWith("trace.zip")) return ["npx", "playwright", "show-trace", path];
  if (process.platform === "darwin") return ["open", path];
  return ["xdg-open", path];
}

function spawnAndWait(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function plural(count: number, singular: string, pluralWord: string): string {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(relativeSafe(value));
}

function relativeSafe(value: string): string {
  return value.replace(/\\/g, "/");
}
