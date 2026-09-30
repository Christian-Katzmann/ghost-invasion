import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Ajv } from "ajv/dist/ajv.js";
import { ghostPlanSchema } from "../dist/schemas/ghost-plan.js";
import { loadManualProject, writeManualProject, writeSupabaseResetConfig, writeUserResetConfig } from "../dist/manual-config.js";

test("manual init writes inspectable config, reset, and a valid plan", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-manual-"));
  try {
    const result = await writeManualProject({
      projectRoot: cwd,
      baseUrl: "http://127.0.0.1:5173/",
      resetCommand: "npm run projectly:reset",
      seedCommand: "npm run projectly:seed",
      role: "member"
    });

    const loaded = await loadManualProject(cwd);
    assert.equal(loaded.config?.baseUrl, "http://127.0.0.1:5173");
    assert.equal(loaded.reset?.strategy, "user-command");
    assert.equal(loaded.reset?.isolation, "user-reset");
    assert.equal(loaded.reset?.resetCommand, "npm run projectly:reset");
    assert.equal(result.plan.safety.dataReset.destructiveAllowed, true);
    // The manual plan compiles its safety block from evaluateSafety(), so approvalRequired
    // is always present (a boolean), not left undefined like the old hand-built block (S-019).
    assert.equal(typeof result.plan.safety.approvalRequired, "boolean");
    assert.equal(result.plan.safety.approvalRequired, false, "quick + local + trusted reset may skip approval");
    assert.equal(result.plan.personas[0]?.role.stateRef, "member.storageState.json");

    const plan = JSON.parse(await readFile(result.paths.plan, "utf8"));
    const validate = new Ajv({ allErrors: true, strict: false }).compile(ghostPlanSchema);
    assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("config reset updates the manual plan safety boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-manual-"));
  try {
    await writeManualProject({ projectRoot: cwd, baseUrl: "http://127.0.0.1:5173", role: "member", seedCommand: "npm run seed" });
    const result = await writeUserResetConfig({ projectRoot: cwd, command: "curl -fsS http://127.0.0.1:5173/api/reset" });

    assert.equal(result.reset.strategy, "user-command");
    assert.equal(result.reset.seedCommand, "npm run seed");
    assert.equal(result.plan?.safety.dataReset.strategy, "user-command");
    assert.equal(result.plan?.safety.dataReset.isolation, "user-reset");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("config supabase-reset updates the plan to the local Supabase reset boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-manual-"));
  try {
    await writeManualProject({ projectRoot: cwd, baseUrl: "http://127.0.0.1:5173", role: "member" });
    const result = await writeSupabaseResetConfig({ projectRoot: cwd });

    assert.equal(result.reset.strategy, "supabase-db-reset");
    assert.equal(result.reset.isolation, "local-stack");
    assert.equal(result.reset.resetCommand, "supabase db reset --local");
    assert.equal(result.plan?.target.stack, "manual");
    assert.equal(result.plan?.target.auth, "supabase");
    assert.equal(result.plan?.safety.dataReset.strategy, "supabase-db-reset");
    assert.equal(result.plan?.safety.dataReset.isolation, "local-stack");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor reads manual config and accepts the user reset boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ghost-manual-"));
  try {
    await writeManualProject({
      projectRoot: cwd,
      baseUrl: "http://127.0.0.1:5173",
      resetCommand: "curl -fsS http://127.0.0.1:5173/api/reset"
    });

    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", "doctor", "--cwd", cwd, "--read-only", "--skip-egress-canary"],
      { encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.dataReset.strategy, "user-command");
    assert.equal(verdict.dataReset.isolation, "user-reset");
    assert.match(verdict.reasons.join("\n"), /data reset accepted: user-command\/user-reset/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
