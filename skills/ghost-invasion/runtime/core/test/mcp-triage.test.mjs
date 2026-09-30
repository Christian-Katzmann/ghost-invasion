import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTriageTool, triageMcpManifest, triageToolDefinitions } from "../dist/mcp-triage.js";
import { reportExample } from "../dist/examples/schema-examples.js";

test("triage MCP facade exposes only read-only tools and queries real run artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-mcp-"));
  const runRoot = join(cwd, ".ghost", "runs", reportExample.runId);
  await mkdir(join(runRoot, "evidence", "chaotic.double-click-save.07"), { recursive: true });
  await writeFile(join(runRoot, "events.jsonl"), `${JSON.stringify({ type: "swarm-complete" })}\n`);
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(reportExample, null, 2)}\n`);
  await writeFile(join(runRoot, "evidence", "chaotic.double-click-save.07", "trace.zip"), "trace placeholder");

  try {
    const manifest = triageMcpManifest();
    assert.equal(manifest.name, "ghost-invasion-triage");
    assert.deepEqual(
      triageToolDefinitions.map((tool) => tool.name).sort(),
      ["ghost_filter_findings", "ghost_get_finding_evidence", "ghost_list_findings"]
    );
    assert(triageToolDefinitions.every((tool) => tool.annotations.readOnlyHint === true));
    assert(triageToolDefinitions.every((tool) => tool.annotations.destructiveHint === false));

    const listed = await callTriageTool("ghost_list_findings", { severity: "critical" }, { projectRoot: cwd });
    assert.equal(listed.runId, reportExample.runId);
    assert.equal(listed.findings.length, 1);
    assert.equal(listed.events.count, 1);

    const evidence = await callTriageTool(
      "ghost_get_finding_evidence",
      { findingId: "F-001", run: reportExample.runId },
      { projectRoot: cwd }
    );
    assert.equal(evidence.finding.id, "F-001");
    assert(evidence.evidence.some((entry) => entry.kind === "trace" && entry.insideRun === true && entry.exists === true));

    await assert.rejects(
      callTriageTool("ghost_update_finding", { findingId: "F-001" }, { projectRoot: cwd }),
      /Unknown read-only Ghost Invasion triage tool/
    );

    const cliManifest = JSON.parse(
      await execJson("node", [join(process.cwd(), "dist", "ghost-invasion.js"), "mcp:triage", "--cwd", cwd], cwd)
    );
    assert.equal(cliManifest.readOnly, true);
    assert.equal(cliManifest.tools.length, 3);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

function execJson(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = import("node:child_process").then(({ spawn }) => {
      const spawned = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      spawned.stdout.on("data", (chunk) => (stdout += chunk));
      spawned.stderr.on("data", (chunk) => (stderr += chunk));
      spawned.on("error", reject);
      spawned.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `command exited ${code}`));
      });
    });
    child.catch(reject);
  });
}
