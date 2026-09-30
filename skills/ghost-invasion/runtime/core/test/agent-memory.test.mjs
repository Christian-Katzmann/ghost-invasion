import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendGhostRunMemory, readGhostAgentMemory } from "../dist/agent-memory.js";
import { ghostPlanExample } from "../dist/examples/schema-examples.js";

test("ghost run memory writes AGENTS.md and imports it from CLAUDE.md", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-memory-"));
  try {
    const result = await appendGhostRunMemory({
      projectRoot: cwd,
      plan: ghostPlanExample,
      runId: "run-1",
      reportPath: join(cwd, ".ghost", "runs", "run-1", "report.json")
    });

    assert.equal(result.claudeImportsAgents, true);
    const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
    assert.match(agents, /safe_base_url: http:\/\/127\.0\.0\.1:5173/);
    assert.match(agents, /reset_strategy: user-command \/ user-reset/);
    assert.match(agents, /success_criteria: double-click-save: projects inserts 1/);

    const claude = await readFile(join(cwd, "CLAUDE.md"), "utf8");
    assert.match(claude, /@AGENTS\.md/);

    const memory = await readGhostAgentMemory(cwd);
    assert.equal(memory.facts.safe_base_url, ghostPlanExample.target.baseUrl);
    assert.equal(memory.facts.default_pack, ghostPlanExample.pack);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});

test("a scratch memory write preserves the hand-written contributor section outside the markers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-memory-"));
  try {
    // Mirror the repo AGENTS.md shape: hand-written orientation above the markers,
    // empty machine-memory block. The contributor section and Vocabulary block must
    // survive a run rewriting the memory between the markers (S-026/S-025).
    const seeded = [
      "# AGENTS.md",
      "",
      "Repo-local agent memory for Ghost Invasion. Keep this file non-secret and stable.",
      "",
      "## For Contributors And Agents",
      "",
      "The command is `ghost-invasion` (never `ghost`).",
      "",
      "### Vocabulary",
      "",
      "`swarm` (plan) == `invasion` (report) == `drone` (runtime events).",
      "",
      "## Ghost Invasion Memory",
      "",
      "Durable, non-secret facts the next Ghost Invasion run can reuse.",
      "<!-- ghost-invasion-memory:start -->",
      "<!-- ghost-invasion-memory:end -->",
      ""
    ].join("\n");
    await writeFile(join(cwd, "AGENTS.md"), seeded, "utf8");

    await appendGhostRunMemory({
      projectRoot: cwd,
      plan: ghostPlanExample,
      runId: "run-1",
      reportPath: join(cwd, ".ghost", "runs", "run-1", "report.json")
    });

    const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
    // The hand-written orientation survives verbatim.
    assert.match(agents, /## For Contributors And Agents/);
    assert.match(agents, /### Vocabulary/);
    assert.match(agents, /`swarm` \(plan\) == `invasion` \(report\) == `drone` \(runtime events\)\./);
    assert.match(agents, /The command is `ghost-invasion` \(never `ghost`\)\./);
    // The machine facts landed inside the markers, not on top of the section.
    assert.match(agents, /safe_base_url: http:\/\/127\.0\.0\.1:5173/);
    // The contributor section stays above the start marker (outside the machine block).
    assert.ok(
      agents.indexOf("## For Contributors And Agents") < agents.indexOf("<!-- ghost-invasion-memory:start -->"),
      "contributor section must remain outside the memory markers"
    );
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
});
