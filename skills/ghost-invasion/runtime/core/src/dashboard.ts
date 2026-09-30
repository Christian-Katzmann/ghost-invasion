import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { Finding } from "./schemas/finding.js";
import type { ReportJson } from "./schemas/report.js";
import { severityCss, severityLabelMap } from "./severity-styles.js";
import type { SwarmRunResult } from "./swarm.js";

export interface DashboardOptions {
  projectRoot?: string;
  run?: string;
}

export interface DashboardFinding {
  id: string;
  title: string;
  severity: Finding["severity"];
  category: Finding["category"];
  confidence: number;
  invariant: string;
  route: string;
  replayArtifact: string | null;
  replayKind: string | null;
}

export interface DashboardSnapshot {
  readOnly: true;
  generatedAt: string;
  runId: string;
  runRoot: string;
  status: string;
  clean: boolean;
  // True when the loaded report.json is a `run --demo-report` fixture. The live dashboard
  // renders a synthetic banner so a demo run pointed at by `dashboard --run` is never
  // mistaken for evidence from a real invasion (S-049).
  synthetic: boolean;
  target: string | null;
  artifacts: {
    events: string | null;
    swarmSummary: string | null;
    reportJson: string | null;
    reportMarkdown: string | null;
    summaryHtml: string | null;
  };
  progress: {
    browserSessions: number;
    browserConcurrency: number;
    browserWaves: number;
    started: number;
    completed: number;
    failed: number;
    active: number;
    apiRequests: number;
    apiEndpointsHit: number;
  };
  pristine: {
    total: number;
    passed: number;
    failed: number;
    quarantined: boolean;
  };
  totals: {
    findings: number;
    critical: number;
    confirmedBugs: number;
    needsHumanReview: number;
    falsePositivesSuppressed: number;
  };
  cost: {
    estimatedUsd: number | null;
    actualUsd: number | null;
    budgetUsd: number | null;
    withinBudget: boolean | null;
    degraded: boolean | null;
  };
  eventCounts: Record<string, number>;
  latestEvents: Array<Record<string, unknown>>;
  findings: DashboardFinding[];
}

export interface DashboardServerOptions extends DashboardOptions {
  host?: string;
  port?: number;
}

export interface DashboardServer {
  url: string;
  host: string;
  port: number;
  runRoot: string;
  server: Server;
  close(): Promise<void>;
}

type JsonRecord = Record<string, unknown>;

const dashboardCss = `
:root {
  color-scheme: light;
  --bg: #f6f7f4;
  --panel: #ffffff;
  --ink: #171a1f;
  --muted: #5c6470;
  --line: #d8ddd5;
  --accent: #107c72;
  --accent-weak: #d8efeb;
  --warn: #a15c00;
  --bad: #b42318;
  --good: #1f7a4d;
  --shadow: 0 14px 34px rgba(23, 26, 31, 0.08);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.45;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}

.shell {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 28px 0 40px;
}

.synthetic-banner {
  background: #fff4e2;
  color: var(--warn);
  border: 1px solid #e6b873;
  border-radius: 8px;
  padding: 12px 14px;
  margin: 0 0 18px;
  font-weight: 700;
}

.synthetic-banner[hidden] {
  display: none;
}

.topbar {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
  border-bottom: 1px solid var(--line);
  padding-bottom: 18px;
}

.brand {
  display: flex;
  gap: 12px;
  align-items: center;
}

.mark {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: var(--ink);
  color: #fff;
  font-weight: 800;
}

h1 {
  margin: 0;
  font-size: 24px;
  line-height: 1.15;
  letter-spacing: 0;
}

.subtle {
  color: var(--muted);
  margin: 4px 0 0;
}

.status {
  min-width: 144px;
  text-align: right;
  font-weight: 700;
}

.status span {
  display: inline-block;
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}

.status span.ok {
  color: var(--good);
  border-color: #b9dfcc;
  background: #eef9f2;
}

.status span.alert {
  color: var(--bad);
  border-color: #f0c4bf;
  background: #fff7f6;
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: 22px 0;
}

.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: var(--shadow);
  padding: 16px;
}

.metric-label {
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.metric-value {
  margin-top: 8px;
  font-size: 28px;
  line-height: 1;
  font-weight: 800;
}

.metric-note {
  color: var(--muted);
  margin-top: 8px;
  min-height: 20px;
}

.main {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr);
  gap: 16px;
}

.section-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.section-title h2 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0;
}

.progress-track {
  height: 10px;
  border-radius: 999px;
  background: #e9ede5;
  overflow: hidden;
  margin: 12px 0 8px;
}

.progress-bar {
  height: 100%;
  width: 0%;
  background: var(--accent);
  transition: width 180ms ease;
}

.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--line);
  padding: 10px 0;
}

.row:first-child {
  border-top: 0;
}

.label {
  color: var(--muted);
}

.value {
  font-weight: 700;
  text-align: right;
}

.finding {
  border-top: 1px solid var(--line);
  padding: 14px 0;
}

.finding:first-of-type {
  border-top: 0;
  padding-top: 0;
}

.finding h3 {
  margin: 0 0 8px;
  font-size: 16px;
  line-height: 1.3;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--muted);
}

.tag {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 8px;
  background: #fbfcfa;
  font-size: 12px;
}

/* Severity styling for all five levels from the shared table, matching the
   static report and never conveying severity by color alone (S-047). */
${severityCss((severity) => `.tag.${severity}`)}

.tag.good {
  color: var(--good);
  border-color: #b9dfcc;
  background: #eef9f2;
}

.events {
  max-height: 480px;
  overflow: auto;
}

.event {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 10px;
  border-top: 1px solid var(--line);
  padding: 9px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.event:first-child {
  border-top: 0;
}

.empty {
  color: var(--muted);
  padding: 20px 0 4px;
}

@media (max-width: 820px) {
  .topbar,
  .main {
    grid-template-columns: 1fr;
    display: block;
  }

  .status {
    text-align: left;
    margin-top: 14px;
  }

  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .main {
    display: grid;
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .shell {
    width: min(100vw - 20px, 1180px);
    padding-top: 18px;
  }

  .grid {
    grid-template-columns: 1fr;
  }

  .event {
    grid-template-columns: 1fr;
  }
}
`;

const dashboardJs = `
const SEVERITY_LABELS = ${JSON.stringify(severityLabelMap())};
const initial = window.__GHOST_DASHBOARD__;
const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

function text(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = String(value);
}

function money(value) {
  return typeof value === "number" ? "$" + fmt.format(value) : "n/a";
}

function render(snapshot) {
  text("run-id", snapshot.runId);
  text("target", snapshot.target || "No target recorded yet");
  text("status", snapshot.status);
  const statusNode = document.getElementById("status");
  if (statusNode) statusNode.className = snapshot.clean ? "ok" : "alert";
  // Surface a loud banner when the loaded run is a synthetic demo report (S-049).
  const syntheticBanner = document.getElementById("synthetic-banner");
  if (syntheticBanner) syntheticBanner.hidden = !snapshot.synthetic;
  text("sessions", snapshot.progress.completed + "/" + snapshot.progress.browserSessions);
  text("waves", snapshot.progress.browserWaves);
  text("findings", snapshot.totals.findings);
  text("critical", snapshot.totals.critical);
  text("cost", money(snapshot.cost.actualUsd ?? snapshot.cost.estimatedUsd));
  text("pristine", snapshot.pristine.failed > 0 ? "quarantine" : snapshot.pristine.passed + "/" + snapshot.pristine.total);
  const pristineNode = document.getElementById("pristine");
  if (pristineNode) pristineNode.className = "tag " + (snapshot.pristine.quarantined ? "critical" : "good");
  text("api", snapshot.progress.apiRequests + " requests");
  text("updated", new Date(snapshot.generatedAt).toLocaleTimeString());

  const total = Math.max(1, snapshot.progress.browserSessions);
  const done = Math.min(total, snapshot.progress.completed + snapshot.progress.failed);
  const pct = Math.round((done / total) * 100);
  const bar = document.getElementById("progress-bar");
  if (bar) bar.style.width = pct + "%";
  // Mirror the visual fill into ARIA so screen readers hear run progress (S-048).
  const track = document.getElementById("progress-track");
  if (track) {
    track.setAttribute("aria-valuenow", String(pct));
    track.setAttribute("aria-valuetext", done + " of " + total + " browser sessions");
  }
  text("progress-note", snapshot.progress.active + " active, " + snapshot.progress.failed + " failed, " + snapshot.progress.apiEndpointsHit + " API endpoint(s)");

  const summary = document.getElementById("summary-rows");
  if (summary) {
    summary.innerHTML = [
      row("Run root", snapshot.runRoot),
      row("Report", link(snapshot.artifacts.reportMarkdown, "report.md")),
      row("Summary", link(snapshot.artifacts.summaryHtml, "summary.html")),
      row("Events", snapshot.eventCounts ? Object.keys(snapshot.eventCounts).length + " event type(s)" : "0"),
      row("Budget", snapshot.cost.budgetUsd === null ? "not set" : money(snapshot.cost.budgetUsd)),
      row("Budget status", snapshot.cost.withinBudget === null ? "n/a" : snapshot.cost.withinBudget ? "within budget" : "over budget")
    ].join("");
  }

  const findings = document.getElementById("findings-list");
  if (findings) {
    findings.innerHTML = snapshot.findings.length
      ? snapshot.findings.map(renderFinding).join("")
      : '<div class="empty">No findings confirmed yet.</div>';
  }

  const events = document.getElementById("events-list");
  if (events) {
    events.innerHTML = snapshot.latestEvents.length
      ? snapshot.latestEvents.map(renderEvent).join("")
      : '<div class="empty">Waiting for run events.</div>';
  }
}

function row(label, value) {
  return '<div class="row"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + value + '</div></div>';
}

function link(path, label) {
  if (!path) return "not written";
  const encoded = encodeURIComponent(path);
  return '<a href="/artifact?path=' + encoded + '">' + escapeHtml(label) + '</a>';
}

function renderFinding(finding) {
  const replay = finding.replayArtifact
    ? '<a href="/artifact?path=' + encodeURIComponent(finding.replayArtifact) + '">' + escapeHtml(finding.replayKind || "replay") + '</a>'
    : 'no replay artifact yet';
  return '<article class="finding"><h3>' + escapeHtml(finding.id + " - " + finding.title) + '</h3><div class="meta">' +
    '<span class="tag ' + escapeHtml(finding.severity) + '">' + escapeHtml(SEVERITY_LABELS[finding.severity] || finding.severity) + '</span>' +
    '<span class="tag">' + escapeHtml(finding.category) + '</span>' +
    '<span class="tag">' + escapeHtml(finding.invariant) + '</span>' +
    '<span class="tag">' + escapeHtml(finding.route) + '</span>' +
    '<span class="tag">' + replay + '</span>' +
    '</div></article>';
}

function renderEvent(event) {
  const ts = typeof event.ts === "string" ? new Date(event.ts).toLocaleTimeString() : "";
  const type = typeof event.type === "string" ? event.type : "event";
  return '<div class="event"><span>' + escapeHtml(ts) + '</span><span>' + escapeHtml(type) + '</span></div>';
}

function escapeHtml(input) {
  return String(input).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function refresh() {
  // Back off while the tab is hidden so a backgrounded dashboard stops polling the
  // run directory (S-035).
  if (document.hidden) return;
  try {
    const response = await fetch("/api/run" + window.location.search, { cache: "no-store" });
    if (response.ok) render(await response.json());
  } catch {
    // Keep the last good snapshot on screen while a run is between writes.
  }
}

render(initial);
setInterval(refresh, 2000);
`;

export async function buildDashboardSnapshot(options: DashboardOptions = {}): Promise<DashboardSnapshot> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const runRoot = await resolveDashboardRunRoot(projectRoot, options.run);
  const [events, summary, report] = await Promise.all([
    readEvents(join(runRoot, "events.jsonl")),
    readJson<SwarmRunResult>(join(runRoot, "swarm-summary.json")),
    readJson<ReportJson>(join(runRoot, "report.json"))
  ]);
  const runId = report?.runId ?? summary?.runId ?? firstString(events, "runId") ?? basename(runRoot);
  const eventCounts = countByType(events);
  const progress = progressFrom(summary, report, events);
  const pristine = pristineFrom(summary, events);
  const totals = report?.totals ?? {
    findings: 0,
    critical: 0,
    confirmedBugs: 0,
    needsHumanReview: 0,
    falsePositivesSuppressed: 0
  };
  const cost = report?.cost ?? summary?.cost ?? null;

  return {
    readOnly: true,
    generatedAt: new Date().toISOString(),
    runId,
    runRoot,
    status: statusFrom(summary, report, events),
    clean: report?.runStatus?.clean ?? false,
    synthetic: report?.synthetic ?? false,
    target: report?.target.url ?? summary?.target ?? null,
    artifacts: {
      events: (await exists(join(runRoot, "events.jsonl"))) ? "events.jsonl" : null,
      swarmSummary: summary ? "swarm-summary.json" : null,
      reportJson: report ? "report.json" : null,
      reportMarkdown: (await exists(join(runRoot, "report.md"))) ? "report.md" : null,
      summaryHtml: (await exists(join(runRoot, "summary.html"))) ? "summary.html" : null
    },
    progress,
    pristine,
    totals,
    cost: {
      estimatedUsd: cost?.estimatedUsd ?? null,
      actualUsd: cost?.actualUsd ?? null,
      budgetUsd: cost?.budgetUsd ?? null,
      withinBudget: cost?.withinBudget ?? null,
      degraded: cost?.degraded ?? null
    },
    eventCounts,
    latestEvents: events.slice(-30),
    findings: summarizeFindings(report?.findings ?? [])
  };
}

export async function renderDashboardHtml(options: DashboardOptions = {}): Promise<string> {
  const snapshot = await buildDashboardSnapshot(options);
  const state = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ghost Invasion Dashboard</title>
  <link rel="stylesheet" href="/assets/dashboard.css" />
</head>
<body>
  <div class="shell">
    <div id="synthetic-banner" class="synthetic-banner" role="alert" hidden>SYNTHETIC DEMO REPORT - no live invasion ran; these findings and artifacts are illustrative fixtures, not evidence from a real run.</div>
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true">GI</div>
        <div>
          <h1>Ghost Invasion Dashboard</h1>
          <p class="subtle"><span id="run-id"></span> · <span id="target"></span></p>
        </div>
      </div>
      <div class="status"><span id="status" role="status" aria-live="polite"></span><p class="subtle">Updated <span id="updated"></span></p></div>
    </header>

    <section class="grid" aria-label="Run metrics">
      <div class="card"><div class="metric-label">Sessions</div><div class="metric-value" id="sessions"></div><div class="metric-note">Browser users completed</div></div>
      <div class="card"><div class="metric-label">Waves</div><div class="metric-value" id="waves"></div><div class="metric-note">Scheduled browser waves</div></div>
      <div class="card"><div class="metric-label">Findings</div><div class="metric-value" id="findings"></div><div class="metric-note"><span id="critical"></span> critical</div></div>
      <div class="card"><div class="metric-label">Cost</div><div class="metric-value" id="cost"></div><div class="metric-note"><span id="api"></span></div></div>
    </section>

    <main class="main">
      <section class="card">
        <div class="section-title"><h2>Run Progress</h2><span class="tag" id="pristine"></span></div>
        <div class="progress-track" id="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Browser session progress"><div class="progress-bar" id="progress-bar"></div></div>
        <p class="subtle" id="progress-note"></p>
        <div id="summary-rows"></div>
      </section>
      <section class="card">
        <div class="section-title"><h2>Recent Events</h2></div>
        <div class="events" id="events-list" role="log" aria-live="polite" aria-label="Recent run events"></div>
      </section>
      <section class="card">
        <div class="section-title"><h2>Findings</h2></div>
        <div id="findings-list" role="region" aria-live="polite" aria-label="Confirmed findings"></div>
      </section>
    </main>
  </div>
  <script>window.__GHOST_DASHBOARD__ = ${state};</script>
  <script src="/assets/dashboard.js"></script>
</body>
</html>`;
}

export async function startDashboardServer(options: DashboardServerOptions = {}): Promise<DashboardServer> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const host = options.host ?? "127.0.0.1";
  assertLoopbackHost(host);
  const runRoot = await resolveDashboardRunRoot(projectRoot, options.run);
  const port = options.port ?? 4317;
  const server = createServer((request, response) => {
    void handleDashboardRequest({ request, response, projectRoot, run: options.run });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const urlHost = host === "::1" ? "[::1]" : host;
  return {
    url: `http://${urlHost}:${address.port}/`,
    host,
    port: address.port,
    runRoot,
    server,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      })
  };
}

export async function resolveDashboardRunRoot(projectRoot: string, run?: string): Promise<string> {
  const root = resolve(projectRoot);
  if (run) {
    const candidate = isAbsolute(run) || run.includes("/") ? resolve(root, run) : join(root, ".ghost", "runs", run);
    const candidateStat = await stat(candidate).catch(() => null);
    if (candidateStat?.isDirectory()) return candidate;
    if (basename(candidate) === "report.json" || basename(candidate) === "events.jsonl" || basename(candidate) === "swarm-summary.json") {
      const parent = resolve(candidate, "..");
      if ((await stat(parent).catch(() => null))?.isDirectory()) return parent;
    }
    throw new Error(`Run artifacts not found: ${candidate}`);
  }

  const runsRoot = join(root, ".ghost", "runs");
  const entries = (await readdir(runsRoot).catch(() => [])).sort().reverse();
  for (const entry of entries) {
    const candidate = join(runsRoot, entry);
    if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
  }
  throw new Error(`No Ghost run directories found under ${runsRoot}`);
}

async function handleDashboardRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  projectRoot: string;
  run?: string;
}): Promise<void> {
  const { request, response, projectRoot, run } = input;
  if (!["GET", "HEAD"].includes(request.method ?? "")) {
    send(response, 405, "text/plain; charset=utf-8", "Ghost dashboard is read-only.\n");
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const selectedRun = url.searchParams.get("run") ?? run;
  try {
    if (url.pathname === "/") {
      send(response, 200, "text/html; charset=utf-8", await renderDashboardHtml({ projectRoot, run: selectedRun ?? undefined }), request.method);
      return;
    }
    if (url.pathname === "/api/run") {
      sendJson(response, await buildDashboardSnapshot({ projectRoot, run: selectedRun ?? undefined }), request.method);
      return;
    }
    if (url.pathname === "/assets/dashboard.css") {
      send(response, 200, "text/css; charset=utf-8", dashboardCss, request.method);
      return;
    }
    if (url.pathname === "/assets/dashboard.js") {
      send(response, 200, "text/javascript; charset=utf-8", dashboardJs, request.method);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      send(response, 204, "image/x-icon", "", request.method);
      return;
    }
    if (url.pathname === "/artifact") {
      const runRoot = await resolveDashboardRunRoot(projectRoot, selectedRun ?? undefined);
      const relativePath = url.searchParams.get("path");
      if (!relativePath) {
        send(response, 400, "text/plain; charset=utf-8", "Missing artifact path.\n", request.method);
        return;
      }
      const artifact = safeArtifactPath(runRoot, relativePath);
      const body = await readFile(artifact);
      send(response, 200, contentTypeFor(artifact), body, request.method);
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found.\n", request.method);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("outside the run directory") ? 403 : 500;
    send(response, status, "text/plain; charset=utf-8", `${message}\n`, request.method);
  }
}

function sendJson(response: ServerResponse, value: unknown, method?: string): void {
  send(response, 200, "application/json; charset=utf-8", `${JSON.stringify(value, null, 2)}\n`, method);
}

function send(response: ServerResponse, status: number, contentType: string, body: string | Buffer, method?: string): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-ghost-dashboard-read-only", "true");
  response.end(method === "HEAD" ? undefined : body);
}

function safeArtifactPath(runRoot: string, relativePath: string): string {
  const root = resolve(runRoot);
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Artifact path is outside the run directory: ${relativePath}`);
  }
  return candidate;
}

function assertLoopbackHost(host: string): void {
  const normalized = host.toLowerCase();
  if (normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1") {
    throw new Error(`Dashboard host must be loopback-only; got ${host}`);
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

// The live dashboard polls /api/run every 2s. Re-reading and re-parsing the entire
// events.jsonl on every tick is O(file-size) work per poll for a file that only ever
// grows (S-035). Cache the parsed events keyed by the file's size+mtime so an
// unchanged file is a single cheap stat() instead of a full read+parse.
const eventsCache = new Map<string, { size: number; mtimeMs: number; events: JsonRecord[] }>();

async function readEvents(path: string): Promise<JsonRecord[]> {
  const stats = await stat(path).catch(() => null);
  if (!stats) {
    eventsCache.delete(path);
    return [];
  }

  const cached = eventsCache.get(path);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return cached.events;
  }

  const body = await readFile(path, "utf8").catch(() => "");
  const events: JsonRecord[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") events.push(parsed as JsonRecord);
    } catch {
      events.push({ type: "unparseable" });
    }
  }
  eventsCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, events });
  return events;
}

function progressFrom(summary: SwarmRunResult | null, report: ReportJson | null, events: JsonRecord[]): DashboardSnapshot["progress"] {
  const completed = countEvents(events, "drone-complete");
  const failed = countEvents(events, "drone-failed");
  const started = countEvents(events, "drone-start");
  return {
    browserSessions: summary?.scale.browserSessions ?? report?.invasion.browserSessions ?? Math.max(started, completed + failed),
    browserConcurrency: summary?.scale.browserConcurrency ?? 0,
    browserWaves: summary?.scale.browserWaves ?? 0,
    started,
    completed: summary?.totals.succeeded ?? completed,
    failed: summary?.totals.failed ?? failed,
    active: Math.max(0, started - completed - failed),
    apiRequests: summary?.scale.apiRequests ?? report?.invasion.apiRequests ?? 0,
    apiEndpointsHit: summary?.scale.apiEndpointsHit ?? report?.invasion.apiEndpointsHit ?? 0
  };
}

function pristineFrom(summary: SwarmRunResult | null, events: JsonRecord[]): DashboardSnapshot["pristine"] {
  const total = summary?.pristine.total ?? countEvents(events, "pristine-sentinel");
  const passed =
    summary?.pristine.passed ?? events.filter((event) => event.type === "pristine-sentinel" && event.ok === true).length;
  const failed =
    summary?.pristine.failed ?? events.filter((event) => event.type === "pristine-sentinel" && event.ok === false).length;
  return { total, passed, failed, quarantined: failed > 0 };
}

function statusFrom(summary: SwarmRunResult | null, report: ReportJson | null, events: JsonRecord[]): string {
  // A finished report must not collapse to a flat "classified" — that reads green even
  // when the run was aborted, a dry run, egress-unproven, or quarantined (S-038, R1).
  if (report) {
    const runStatus = report.runStatus;
    if (runStatus) {
      if (runStatus.clean) return "clean";
      if (runStatus.state === "dry-run") return "dry-run";
      if (runStatus.state === "circuit-breaker") return "circuit-breaker";
      if (runStatus.quarantined) return "quarantined";
      if (!runStatus.egressProven) return "egress-unproven";
      return "incomplete";
    }
    return "classified";
  }
  if (summary) return summary.status;
  if (events.some((event) => event.type === "swarm-complete")) return "completed";
  if (events.some((event) => event.type === "drone-start")) return "running";
  return "waiting";
}

function countByType(events: JsonRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function countEvents(events: JsonRecord[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function firstString(events: JsonRecord[], key: string): string | null {
  for (const event of events) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function summarizeFindings(findings: Finding[]): DashboardFinding[] {
  return findings.map((finding) => {
    const replayArtifact = finding.evidence.find((entry) => /\.(zip|webm|har|png)$/i.test(entry)) ?? null;
    return {
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      confidence: finding.confidence,
      invariant: finding.invariant,
      route: finding.affected.route,
      replayArtifact,
      replayKind: replayArtifact ? evidenceKind(replayArtifact) : null
    };
  });
}

function evidenceKind(path: string): string {
  if (path.endsWith(".zip")) return "trace";
  if (path.endsWith(".webm")) return "video";
  if (path.endsWith(".har")) return "HAR";
  if (path.endsWith(".png")) return "screenshot";
  return "artifact";
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".json":
    case ".jsonl":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".webm":
      return "video/webm";
    case ".har":
      return "application/json; charset=utf-8";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}
