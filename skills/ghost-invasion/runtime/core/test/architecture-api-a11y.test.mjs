// Batch 12 (Stage 3): architecture / API surface / accessibility.
// Locks the behavior boundaries for S-032 (curated public API), S-034 (typed
// liveSecrets + consistent $schema discriminator), and S-047/S-048 (non-color
// severity channel + assistive-tech labels).

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv/dist/ajv.js";

import * as publicApi from "../dist/index.js";
import { SEVERITY_ORDER, SEVERITY_STYLES, severityCss, severityLabel } from "../dist/severity-styles.js";
import { renderDashboardHtml, startDashboardServer } from "../dist/dashboard.js";
import { renderReportArtifactsFromRun } from "../dist/reporter.js";
import { createEmptySafetyVerdict } from "../dist/safety.js";
import { safetyVerdictExample, ghostPlanExample, reportExample } from "../dist/examples/schema-examples.js";
import { versionedSchemas } from "../dist/schemas/index.js";

// --- S-032: the public package surface is curated, not the internal barrel ----

test("public API exposes the curated surface and hides runner internals (S-032)", () => {
  // The supported, semver-bound surface: safety spine + evidence + schema contracts.
  for (const name of ["evaluateSafety", "createEmptySafetyVerdict", "EvidenceBus", "createRunId", "versionedSchemas", "safetyVerdictSchema", "ghostPlanSchema"]) {
    assert.ok(name in publicApi, `public API must export ${name}`);
  }
  // Runner/drone internals must NOT leak into the published API.
  for (const internal of ["runSwarm", "scanProject", "classifyRun", "renderDashboardHtml", "SvelteKitAdapter", "ExpressAdapter"]) {
    assert.ok(!(internal in publicApi), `public API must not export internal ${internal}`);
  }
});

// --- S-034: typed liveSecrets + one consistent $schema discriminator ----------

test("every safety verdict carries the $schema discriminator (S-034)", () => {
  assert.equal(safetyVerdictExample.$schema, "ghost-invasion/safety-verdict@1");
  assert.equal(createEmptySafetyVerdict().$schema, "ghost-invasion/safety-verdict@1");
  assert.ok(versionedSchemas.safetyVerdict.required.includes("$schema"), "safety-verdict schema must require $schema");
});

test("plan liveSecrets uses the verdict's typed item shape, not loose strings (S-034)", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(versionedSchemas.ghostPlan);

  // The typed item shape round-trips.
  const typedPlan = JSON.parse(JSON.stringify(ghostPlanExample));
  typedPlan.safety.liveSecrets = [{ key: "STRIPE_SECRET_KEY", provider: "stripe", severity: "high", last4: "9999" }];
  assert.ok(validate(typedPlan), `typed liveSecrets plan must validate: ${JSON.stringify(validate.errors)}`);

  // The old loose `unknown[]` string form (which forced the deleted classifier
  // sniff) is now rejected by the contract.
  const loosePlan = JSON.parse(JSON.stringify(ghostPlanExample));
  loosePlan.safety.liveSecrets = ["STRIPE_SECRET_KEY"];
  assert.ok(!validate(loosePlan), "a bare-string liveSecret must no longer validate");
});

// --- S-047: non-color severity channel + all five levels styled --------------

test("severity styles give every level a distinct glyph and word (S-047)", () => {
  assert.deepEqual(SEVERITY_ORDER, ["critical", "high", "medium", "low", "info"]);
  const glyphs = new Set();
  for (const severity of SEVERITY_ORDER) {
    const style = SEVERITY_STYLES[severity];
    assert.ok(style && style.glyph, `${severity} needs a glyph`);
    glyphs.add(style.glyph);
    const label = severityLabel(severity);
    assert.ok(label.includes(severity.toUpperCase()), `${severity} label must include the word`);
    assert.ok(label.startsWith(style.glyph), `${severity} label must lead with its glyph`);
  }
  // Distinct shapes → distinguishable in grayscale, not by color alone.
  assert.equal(glyphs.size, SEVERITY_ORDER.length, "each severity needs a distinct glyph");

  // The shared CSS helper styles all five levels (no missing low/info).
  const css = severityCss((severity) => `.tag.${severity}`);
  for (const severity of SEVERITY_ORDER) {
    assert.ok(css.includes(`.tag.${severity} {`), `severityCss must emit a rule for ${severity}`);
  }
});

test("summary.html styles and labels low/info findings without color alone (S-047)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-a11y-"));
  const report = JSON.parse(JSON.stringify(reportExample));
  // Force the two previously-unstyled levels to appear.
  report.findings[0].severity = "low";
  if (report.findings[1]) report.findings[1].severity = "info";
  const runRoot = join(cwd, ".ghost", "runs", report.runId);
  await mkdir(join(runRoot, "evidence", "chaotic.double-click-save.07"), { recursive: true });
  await writeFile(join(runRoot, "evidence", "chaotic.double-click-save.07", "trace.zip"), "trace placeholder");
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  try {
    const artifacts = await renderReportArtifactsFromRun(runRoot);
    const html = await readFile(artifacts.summaryHtml, "utf8");
    assert.ok(html.includes(".pill.low {"), "summary.html must style low pills");
    assert.ok(html.includes(".pill.info {"), "summary.html must style info pills");
    assert.ok(html.includes(severityLabel("low")), "summary.html must show the low glyph + word");
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

// --- S-048: dashboard announces to assistive tech ----------------------------

test("dashboard markup carries aria-live regions and a labeled progressbar (S-048)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-a11y-dash-"));
  const runRoot = join(cwd, ".ghost", "runs", reportExample.runId);
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(reportExample, null, 2)}\n`);
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ runId: reportExample.runId, type: "swarm-complete" })}\n`);

  let dashboard;
  try {
    const html = await renderDashboardHtml({ projectRoot: cwd, run: reportExample.runId });
    assert.ok(html.includes('role="status"') && html.includes('aria-live="polite"'), "status must be a polite live region");
    assert.ok(html.includes('role="progressbar"') && html.includes('aria-valuenow'), "progress needs a progressbar role + value");
    assert.ok(html.includes('id="findings-list"') && /id="findings-list"[^>]*aria-live/.test(html), "findings list must announce updates");
    assert.ok(html.includes('class="mark" aria-hidden="true"'), "decorative GI mark must be hidden from AT");

    // The served assets carry the severity CSS for all levels and the glyph+word labels.
    dashboard = await startDashboardServer({ projectRoot: cwd, run: reportExample.runId, port: 0 });
    const css = await (await fetch(new URL("/assets/dashboard.css", dashboard.url))).text();
    assert.ok(css.includes(".tag.low {") && css.includes(".tag.info {"), "dashboard CSS must style low/info");
    const js = await (await fetch(new URL("/assets/dashboard.js", dashboard.url))).text();
    assert.ok(js.includes(severityLabel("critical")), "dashboard script must inject the glyph + word labels");
  } finally {
    if (dashboard) await dashboard.close();
    await rm(cwd, { force: true, recursive: true });
  }
});
