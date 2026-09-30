#!/usr/bin/env node
import { authorizeLocalRun } from "./local-boundary.js";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command } from "commander";
import { chromium } from "playwright";
import { scanProject, writeDiscoveryArtifacts, type StackAdapterId } from "./discovery.js";
import { runContainerCanaryMatrix } from "./egress.js";
import { ensureGhostLayout } from "./ghost-layout.js";
import {
  loadManualProject,
  resolveAgainstBaseUrl,
  storageStatePathFor,
  writeManualProject,
  writeSupabaseResetConfig,
  writeUserResetConfig
} from "./manual-config.js";
import { writeMemorySizingMarkdown } from "./memory-sizing.js";
import { callTriageTool, triageMcpManifest } from "./mcp-triage.js";
import { rerunFindingFix, writeSuggestedFixes } from "./fix.js";
import { mergeShardReports, renderDemoReport, renderReportArtifactsFromRun, replayFinding, resolveReportRunRoot } from "./reporter.js";
import { startDashboardServer } from "./dashboard.js";
import { createEmptySafetyVerdict, evaluateSafety } from "./safety.js";
import { reproFinding, shrinkFinding } from "./shrinker.js";
import { ClerkAuthAdapter } from "./clerk-adapter.js";
import { FirebaseAuthAdapter } from "./firebase-adapter.js";
import { SupabaseAuthAdapter, SupabaseSeedAdapter } from "./supabase-adapter.js";
import { AuthJsAuthAdapter } from "./authjs-adapter.js";
import { runSwarm } from "./swarm.js";
import { compileInvasionPlan } from "./planner.js";
import { formatRunModeEcho, runModeHelpText, selectRunMode } from "./run-modes.js";
import { parseExitCodeOnSeverity, reportMeetsExitCodeThreshold } from "./exit-code-policy.js";
import { parseSeed } from "./seed.js";
import { validateReportJson, type ReportJson } from "./schemas/report.js";

const program = new Command();

program
  .name("ghost-invasion")
  .description("AI-planned, deterministic fake-user invasions for web apps.")
  .version("0.1.0");

program
  .command("doctor")
  .description("Verify adapters, env safety, mocks, egress trap, and reset strategy.")
  .option("--explain", "Print a plain-English explanation of the safety verdict")
  .option("--base-url <url>", "Target base URL")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--mode <mode>", "Run mode to gate", "quick")
  .option("--reset-strategy <strategy>", "Reset strategy")
  .option("--data-isolation <isolation>", "Isolation proof")
  .option("--allow-production-target", "Permit production-risk targets")
  .option("--read-only", "Evaluate read-only attach mode")
  .option("--skip-egress-canary", "Do not execute the Docker canary probe")
  .action(async (options: {
    explain?: boolean;
    baseUrl?: string;
    cwd: string;
    mode: string;
    resetStrategy?: string;
    dataIsolation?: string;
    allowProductionTarget?: boolean;
    readOnly?: boolean;
    skipEgressCanary?: boolean;
  }) => {
    const manualProject = await loadManualProject(options.cwd);
    const baseUrl = options.baseUrl ?? manualProject.config?.baseUrl;
    const resetStrategy = options.resetStrategy ?? manualProject.reset?.strategy ?? "none";
    const dataIsolation = options.dataIsolation ?? manualProject.reset?.isolation ?? "unknown";
    const verdict = baseUrl
      ? await evaluateSafety({
          baseUrl,
          cwd: options.cwd,
          mode: options.mode,
          resetStrategy,
          dataIsolation,
          allowProductionTarget: options.allowProductionTarget,
          mutating: !options.readOnly,
          runEgressCanary: !options.skipEgressCanary
        })
      : createEmptySafetyVerdict();
    // Lead with the plain-English verdict for a human at a terminal (or on --explain);
    // keep the full JSON below it so piped/agent consumers still get the machine record (S-052).
    if (options.explain || process.stdout.isTTY) {
      console.log(verdict.explain);
    }
    console.log(JSON.stringify(verdict, null, 2));
    // Both a hard block and an unconfigured target are non-green: there is nothing to
    // run yet, so the command must not exit 0 and read as success (S-046).
    if (verdict.verdict === "block" || verdict.verdict === "not-configured") {
      process.exitCode = 1;
    }
  });

const egress = program.command("egress").description("Inspect network egress enforcement.");

egress
  .command("canary")
  .description("Run the container-firewall canary matrix.")
  .action(async () => {
    console.log(JSON.stringify(await runContainerCanaryMatrix(), null, 2));
  });

program
  .command("memory-spike")
  .description("Measure chromium-headless-shell RSS for 1/2/4/8 contexts.")
  .requiredOption("--base-url <url>", "Running Projectly base URL")
  .requiredOption("--output <path>", "Markdown report path")
  .action(async (options: { baseUrl: string; output: string }) => {
    const report = await writeMemorySizingMarkdown(options.baseUrl, options.output);
    console.log(JSON.stringify(report, null, 2));
  });

program
  .command("init")
  .description("Create .ghost/ project files.")
  .option("--manual", "Use the manual-first setup path")
  .option("--base-url <url>", "Target base URL for manual mode")
  .option("--reset-command <command>", "User-owned reset command for mutating runs")
  .option("--seed-command <command>", "Optional seed command to run after reset")
  .option("--mode <mode>", "Default run mode", "quick")
  .option("--pack <pack>", "Default risk pack", "launch-readiness")
  .option("--role <role>", "Default auth role for recorded storageState", "member")
  .option("--cwd <path>", "Project root", process.cwd())
  .action(async (options: {
    manual?: boolean;
    baseUrl?: string;
    resetCommand?: string;
    seedCommand?: string;
    mode: string;
    pack: string;
    role: string;
    cwd: string;
  }) => {
    if (!options.manual) {
      const paths = await ensureGhostLayout(options.cwd);
      console.log(JSON.stringify({ command: "init", manual: false, wrote: paths.root }, null, 2));
      return;
    }

    if (!options.baseUrl) {
      program.error("init --manual requires --base-url so the generated plan is inspectable and replayable.");
      return;
    }

    const result = await writeManualProject({
      projectRoot: options.cwd,
      baseUrl: options.baseUrl,
      resetCommand: options.resetCommand,
      seedCommand: options.seedCommand,
      mode: options.mode,
      pack: options.pack,
      role: options.role
    });

    console.log(
      JSON.stringify(
        {
          command: "init",
          manual: true,
          config: result.paths.ghostConfig,
          reset: result.paths.resetConfig,
          plan: result.paths.plan,
          baseUrl: result.config.baseUrl,
          resetStrategy: result.reset.strategy,
          authState: `${result.config.authRole}.storageState.json`
        },
        null,
        2
      )
    );
  });

program
  .command("scan")
  .description("Discover surfaces and draft the invasion plan.")
  .option("--adapter <adapter>", "Adapter id", "auto")
  .option("--auth <auth>", "Auth adapter id", "auto")
  .option("--base-url <url>", "Target base URL")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--skip-build", "Skip framework build-manifest corroboration")
  .action(
    async (options: {
      // Derived from StackAdapterId (discovery.ts) so a new adapter id flows here
      // automatically — no hand-maintained literal to forget (S-028).
      adapter: "auto" | StackAdapterId;
      auth: string;
      baseUrl?: string;
      cwd: string;
      skipBuild?: boolean;
    }) => {
      const result = await scanProject({
        projectRoot: options.cwd,
        adapter: options.adapter,
        runBuild: !options.skipBuild
      });
      const artifacts = await writeDiscoveryArtifacts(result, options.cwd);
      console.log(
        JSON.stringify(
          {
            command: "scan",
            adapter: options.adapter,
            auth: options.auth,
            baseUrl: options.baseUrl ?? null,
            surfaces: result.surfaces.length,
            degradations: result.degradations,
            markdown: artifacts.markdownPath,
            json: artifacts.jsonPath
          },
          null,
          2
        )
      );
    }
  );

program
  .command("plan")
  .description("Compile personas, journeys, and invariants into an editable plan.")
  .option("--personas <list>", "Comma-separated persona ids")
  .option("--journeys <count>", "Journey count")
  .option("--swarm-size <count>", "Total browser session count")
  .option("--seed <seed>", "Deterministic seed", "1337")
  .option("--base-url <url>", "Target base URL; defaults to init --manual config")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--mode <mode>", "Run mode", "quick")
  .option("--pack <pack>", "Named risk pack")
  .option("--approve", "Mark the generated local quick plan as approved")
  .option("--skip-egress-canary", "Do not refresh the Docker canary proof while compiling the plan")
  .action(
    async (options: {
      personas?: string;
      journeys?: string;
      swarmSize?: string;
      seed: string;
      baseUrl?: string;
      cwd: string;
      mode: string;
      pack?: string;
      approve?: boolean;
      skipEgressCanary?: boolean;
    }) => {
      const result = await compileInvasionPlan({
        projectRoot: options.cwd,
        baseUrl: options.baseUrl,
        personas: options.personas?.split(",").map((entry) => entry.trim()).filter(Boolean),
        journeyCount: options.journeys ? Number.parseInt(options.journeys, 10) : undefined,
        swarmSize: options.swarmSize ? Number.parseInt(options.swarmSize, 10) : undefined,
        seed: parseSeed(options.seed),
        mode: options.mode,
        pack: options.pack,
        approve: options.approve,
        runEgressCanary: !options.skipEgressCanary
      });
      console.log(
        JSON.stringify(
          {
            command: "plan",
            plan: result.planPath,
            personas: result.plan.personas.length,
            journeys: result.plan.journeys.length,
            approvedPlanHash: result.plan.approvedPlanHash,
            personasMarkdown: result.personasMarkdown,
            journeysMarkdown: result.journeysMarkdown
          },
          null,
          2
        )
      );
    }
  );

program.command("authorize-local")
  .description("Authorize a disposable numeric-loopback target, plan and HTTP reset endpoint for browser-origin isolation")
  .requiredOption("--reset-path <path>", "Same-origin HTTP POST reset endpoint")
  .option("--confirm-disposable-target", "Confirm you own this disposable app and authorize its reset endpoint")
  .option("--max-sessions <count>", "Authorized scheduled sessions, 1..20; baseline and trace retry may add up to two contexts each", "4")
  .option("--max-workers <count>", "Authorized workers, 1..2", "1")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--plan <path>", "Plan JSON path")
  .action(async options => console.log(JSON.stringify(await authorizeLocalRun({ projectRoot: options.cwd, planPath: options.plan, resetPath: options.resetPath, maxSessions: Number(options.maxSessions), maxWorkers: Number(options.maxWorkers), confirmDisposable: Boolean(options.confirmDisposableTarget) }), null, 2)));

program
  .command("run")
  .description("Execute the deterministic swarm against an approved plan.")
  .option("--quick", "Run mode (group): quick scan — the default")
  .option("--deep", "Run mode (group): deep scan")
  .option("--mobile", "Run mode (group): mobile personas")
  .option("--auth", "Run mode (group): auth-boundary personas")
  .option("--payments", "Run mode (group): payment journeys")
  .option("--admin", "Run mode (group): admin journeys")
  .option("--concurrency", "Run mode (group): concurrency journeys")
  .option("--chaos", "Run mode (group): mistake-injection journeys")
  .option("--permission", "Run mode (group): permission-boundary journeys")
  .option("--ux", "Run mode (group): UX journeys")
  .option("--performance", "Run mode (group): performance journeys")
  .option("--fix-critical", "Run mode (group): target critical findings")
  .option("--demo-report", "Render demo report artifacts")
  .option("--pack <pack>", "Named risk pack")
  .option("--only <id>", "Finding or journey id to re-run")
  .option("--allow-production-target", "Permit non-local target checks")
  .option("--seed <seed>", "Deterministic seed", "1337")
  .option("--workers <count>", "Worker count")
  .option("--sessions <count>", "Override total browser sessions")
  .option("--rate <rps>", "API request rate")
  .option("--api-requests <count>", "API tier request budget")
  .option("--repro-budget <count>", "Per-fingerprint reproduction rerun budget")
  .option("--shard <k/n>", "Run one process shard, for example 2/4")
  .option("--budget-usd <amount>", "Scout spend cap")
  .option("--local-only", "Use explicitly authorized browser-origin isolation; budget must be 0")
  .option("--write-agent-memory", "Explicitly update AGENTS.md and CLAUDE.md after the run")
  .option("--exit-code-on <severity>", "Exit non-zero when a confirmed finding meets severity: critical, high, medium, low, or info")
  .option("--reset <mode>", "Reset mode")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--plan <path>", "Plan JSON path; defaults to .ghost/plan/ghost-invasion-plan.json")
  .option("--base-url <url>", "Override plan target base URL")
  .option("--trace-cap <count>", "Per-fingerprint trace cap", "3")
  .option("--dry-run", "Do not execute browsers")
  .action(
    async (options: {
      quick?: boolean;
      deep?: boolean;
      mobile?: boolean;
      auth?: boolean;
      payments?: boolean;
      admin?: boolean;
      concurrency?: boolean;
      chaos?: boolean;
      permission?: boolean;
      ux?: boolean;
      performance?: boolean;
      fixCritical?: boolean;
      only?: string;
      seed: string;
      workers?: string;
      sessions?: string;
      rate?: string;
      apiRequests?: string;
      reproBudget?: string;
      shard?: string;
      budgetUsd?: string;
      writeAgentMemory?: boolean;
      localOnly?: boolean;
      exitCodeOn?: string;
      demoReport?: boolean;
      dryRun?: boolean;
      allowProductionTarget?: boolean;
      cwd: string;
      plan?: string;
      baseUrl?: string;
      pack?: string;
      traceCap: string;
      reset?: string;
    }) => {
      if (options.demoReport) {
        const result = await renderDemoReport({ projectRoot: options.cwd });
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const exitCodeThreshold = options.exitCodeOn ? parseExitCodeOnSeverity(options.exitCodeOn) : null;
      const modeFlags = {
        quick: options.quick,
        deep: options.deep,
        mobile: options.mobile,
        auth: options.auth,
        payments: options.payments,
        admin: options.admin,
        concurrency: options.concurrency,
        chaos: options.chaos,
        permission: options.permission,
        ux: options.ux,
        performance: options.performance,
        "fix-critical": options.fixCritical
      };
      const mode = Object.values(modeFlags).some(Boolean) ? selectRunMode(modeFlags) : undefined;
      // Echo the resolved run mode (to stderr, so stdout stays pure result JSON for agents)
      // so the precedence decision is visible rather than inferred from behaviour (S-052).
      console.error(formatRunModeEcho(modeFlags));
      const result = await runSwarm({
        projectRoot: options.cwd,
        planPath: options.plan,
        baseUrl: options.baseUrl,
        ...(mode ? { mode } : {}),
        pack: options.pack,
        only: options.only,
        seed: parseSeed(options.seed),
        workers: options.workers ? Number.parseInt(options.workers, 10) : undefined,
        sessions: options.sessions ? Number.parseInt(options.sessions, 10) : undefined,
        rateRps: options.rate ? Number.parseInt(options.rate, 10) : undefined,
        apiRequestBudget: options.apiRequests ? Number.parseInt(options.apiRequests, 10) : undefined,
        reproductionBudget: options.reproBudget ? Number.parseInt(options.reproBudget, 10) : undefined,
        budgetUsd: options.budgetUsd ? Number.parseFloat(options.budgetUsd) : undefined,
        writeAgentMemory: options.writeAgentMemory,
        localOnly: options.localOnly,
        shard: options.shard,
        traceCapPerFingerprint: Number.parseInt(options.traceCap, 10),
        dryRun: options.dryRun,
        allowProductionTarget: options.allowProductionTarget,
        runReset: options.reset !== "none"
      });
      console.log(JSON.stringify(result, null, 2));
      if (exitCodeThreshold) {
        if (!result.classification?.reportJson) {
          process.exitCode = 1;
          return;
        }
        // Validate report.json against the bundled schema before trusting it for the
        // exit-code decision. A truncated / hand-edited / critical-stripped report (or
        // one that fails to parse) must fail closed, never silently read green (S-020, R1).
        let report: ReportJson;
        try {
          report = validateReportJson(JSON.parse(await readFile(result.classification.reportJson, "utf8")));
        } catch (error) {
          process.exitCode = 1;
          console.error(error instanceof Error ? error.message : String(error));
          return;
        }
        if (reportMeetsExitCodeThreshold(report, exitCodeThreshold)) process.exitCode = 1;
      }
    }
  )
  .addHelpText("after", `\n${runModeHelpText}\n`);

program
  .command("report")
  .description("Render report.md and summary.html from report.json.")
  .option("--run <id>", "Run id")
  .option("--cwd <path>", "Project root", process.cwd())
  .action(async (options: { run?: string; cwd: string }) => {
    const runRoot = await resolveReportRunRoot(options.cwd, options.run);
    const artifacts = await renderReportArtifactsFromRun(runRoot);
    console.log(JSON.stringify({ command: "report", runRoot, ...artifacts }, null, 2));
  });

program
  .command("dashboard")
  .description("Serve a read-only live dashboard over Ghost run artifacts.")
  .option("--run <id>", "Run id, run directory, or artifact path; defaults to latest run directory")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--host <host>", "Loopback host", "127.0.0.1")
  .option("--port <port>", "Port", "4317")
  .action(async (options: { run?: string; cwd: string; host: string; port: string }) => {
    const port = Number.parseInt(options.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      program.error("--port must be an integer from 0 to 65535.");
    }
    const dashboard = await startDashboardServer({
      projectRoot: options.cwd,
      run: options.run,
      host: options.host,
      port
    });

    console.log(
      JSON.stringify(
        {
          command: "dashboard",
          readOnly: true,
          bind: `${dashboard.host}:${dashboard.port}`,
          url: dashboard.url,
          runRoot: dashboard.runRoot
        },
        null,
        2
      )
    );

    const shutdown = async () => {
      await dashboard.close();
    };
    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });
  });

program
  .command("merge-shards")
  .description("Merge completed ghost-invasion run --shard reports into one report.")
  .argument("<runs...>", "Shard run ids, directories, or report.json paths")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--run-id <id>", "Merged run id")
  .action(async (runs: string[], options: { cwd: string; runId?: string }) => {
    const result = await mergeShardReports({
      projectRoot: options.cwd,
      shards: runs,
      runId: options.runId
    });
    console.log(JSON.stringify({ command: "merge-shards", ...result }, null, 2));
  });

program
  .command("replay")
  .description("Open the Playwright trace or video for a finding.")
  .argument("<id>", "Finding id")
  .option("--run <id>", "Run id")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--print", "Print the replay command without opening it")
  .action(async (id: string, options: { run?: string; cwd: string; print?: boolean }) => {
    const result = await replayFinding({
      projectRoot: options.cwd,
      findingId: id,
      run: options.run,
      printOnly: options.print
    });
    console.log(JSON.stringify({ command: "replay", ...result }, null, 2));
  });

program
  .command("shrink")
  .description("Delta-debug a long failing session into a minimal reproduction.")
  .argument("<id>", "Finding id")
  .option("--run <id>", "Run id")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--plan <path>", "Plan JSON path; defaults to .ghost/plan/ghost-invasion-plan.json")
  .option("--max-candidates <count>", "Maximum shrink candidates to evaluate", "80")
  .action(async (id: string, options: { run?: string; cwd: string; plan?: string; maxCandidates: string }) => {
    const result = await shrinkFinding(id, {
      projectRoot: options.cwd,
      run: options.run,
      planPath: options.plan,
      maxCandidates: Number.parseInt(options.maxCandidates, 10)
    });
    console.log(JSON.stringify({ command: "shrink", ...result }, null, 2));
  });

program
  .command("repro")
  .description("Print or replay the minimal reproduction for a finding.")
  .argument("<id>", "Finding id")
  .option("--run <id>", "Run id")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--plan <path>", "Plan JSON path; defaults to the plan recorded in the minimal repro")
  .option("--execute", "Run the minimized journey instead of only printing it")
  .option("--json", "Print JSON instead of human-readable steps")
  .action(async (id: string, options: { run?: string; cwd: string; plan?: string; execute?: boolean; json?: boolean }) => {
    const result = await reproFinding(id, {
      projectRoot: options.cwd,
      run: options.run,
      planPath: options.plan,
      execute: options.execute
    });
    if (options.json) {
      console.log(JSON.stringify({ command: "repro", ...result }, null, 2));
      return;
    }
    console.log(result.summary);
    if (result.execution) {
      console.log(JSON.stringify({ command: "repro", execution: result.execution }, null, 2));
    }
  });

program
  .command("fix")
  .description("Propose fixes for confirmed findings, or prove a manual fix with a targeted rerun.")
  .option("--run <id>", "Run id")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--plan <path>", "Plan JSON path; defaults to .ghost/plan/ghost-invasion-plan.json")
  .option("--rerun <findingId>", "Re-run one finding after a manual fix")
  .option("--reset <mode>", "Reset mode")
  .action(async (options: { run?: string; cwd: string; plan?: string; rerun?: string; reset?: string }) => {
    if (options.rerun) {
      const result = await rerunFindingFix(options.rerun, {
        projectRoot: options.cwd,
        run: options.run,
        planPath: options.plan,
        runReset: options.reset !== "none"
      });
      console.log(JSON.stringify({ command: "fix", mode: "rerun", ...result }, null, 2));
      if (result.status !== "green") process.exitCode = 1;
      return;
    }

    const result = await writeSuggestedFixes({ projectRoot: options.cwd, run: options.run });
    console.log(JSON.stringify({ command: "fix", mode: "suggest", ...result }, null, 2));
  });

program
  .command("mcp:triage")
  .description("Expose read-only MCP triage tools over completed run artifacts.")
  .option("--run <id>", "Run id, run directory, or report.json path")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--tool <name>", "Read-only tool to call; omit to print the tool manifest")
  .option("--args <json>", "Tool arguments JSON", "{}")
  .action(async (options: { run?: string; cwd: string; tool?: string; args: string }) => {
    if (!options.tool) {
      console.log(JSON.stringify({ command: "mcp:triage", readOnly: true, ...triageMcpManifest() }, null, 2));
      return;
    }

    const parsedArgs = JSON.parse(options.args || "{}") as Record<string, unknown>;
    const result = await callTriageTool(options.tool, { run: options.run, ...parsedArgs }, { projectRoot: options.cwd });
    console.log(JSON.stringify({ command: "mcp:triage", readOnly: true, tool: options.tool, result }, null, 2));
  });

program
  .command("auth:record")
  .description("Record a headed login and save storageState.")
  .option("--role <role>", "Role id", "member")
  .requiredOption("--base-url <url>", "Target base URL")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--login-url <url>", "URL or path to open before capture")
  .option("--wait-for-url <glob>", "URL/glob that means login is complete")
  .option("--timeout-ms <ms>", "Maximum capture wait", "120000")
  .option("--output <path>", "StorageState output path")
  .option("--headless", "Run headless for CI/demo verification; default is headed")
  .action(async (options: {
    role: string;
    baseUrl: string;
    cwd: string;
    loginUrl?: string;
    waitForUrl?: string;
    timeoutMs: string;
    output?: string;
    headless?: boolean;
  }) => {
    const timeout = Number.parseInt(options.timeoutMs, 10);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      program.error("--timeout-ms must be a positive integer.");
    }

    const output = storageStatePathFor(options.cwd, options.role, options.output);
    await mkdir(dirname(output), { recursive: true });

    const browser = await chromium.launch({ headless: Boolean(options.headless) });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const target = resolveAgainstBaseUrl(options.baseUrl, options.loginUrl);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout });

      if (options.waitForUrl) {
        const waitForUrl = options.waitForUrl.startsWith("/")
          ? resolveAgainstBaseUrl(options.baseUrl, options.waitForUrl)
          : options.waitForUrl;
        await page.waitForURL(waitForUrl, { timeout });
      } else {
        await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 10_000) }).catch(() => undefined);
      }

      await context.storageState({ path: output });
      console.log(JSON.stringify({ command: "auth:record", role: options.role, storageState: output }, null, 2));
    } finally {
      await browser.close();
    }
  });

program
  .command("auth:supabase")
  .description("Mint a Supabase-local storageState without a UI login.")
  .requiredOption("--email <email>", "Supabase auth email to provision/sign in")
  .option("--role <role>", "Role id", "member")
  .requiredOption("--base-url <url>", "Target app base URL for the Playwright storage origin")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--output <path>", "StorageState output path")
  .option("--method <method>", "otp-token-hash or service-role-jwt", "otp-token-hash")
  .option("--provision", "Create/confirm the local Supabase user with the service-role API before minting")
  .option("--user-id <id>", "Known auth.users id for service-role-jwt minting")
  .option("--timeout-ms <ms>", "Maximum Mailpit polling wait", "30000")
  .action(
    async (options: {
      email: string;
      role: string;
      baseUrl: string;
      cwd: string;
      output?: string;
      method: "otp-token-hash" | "service-role-jwt";
      provision?: boolean;
      userId?: string;
      timeoutMs: string;
    }) => {
      if (!["otp-token-hash", "service-role-jwt"].includes(options.method)) {
        program.error("--method must be otp-token-hash or service-role-jwt.");
      }
      const adapter = new SupabaseAuthAdapter({ projectRoot: options.cwd });
      let userId = options.userId;
      if (options.provision) {
        const [user] = await adapter.provisionUsers([{ role: options.role, email: options.email, id: options.userId }]);
        userId = user?.id ?? userId;
      }
      const output = storageStatePathFor(options.cwd, options.role, options.output);
      const result = await adapter.mintSession({
        role: options.role,
        email: options.email,
        appBaseUrl: options.baseUrl,
        storageStatePath: output,
        method: options.method,
        userId,
        timeoutMs: Number.parseInt(options.timeoutMs, 10)
      });
      console.log(
        JSON.stringify(
          {
            command: "auth:supabase",
            role: result.role,
            email: result.email,
            method: result.method,
            storageState: result.storageStatePath,
            appOrigin: result.appOrigin,
            storageKey: result.storageKey
          },
          null,
          2
        )
      );
    }
  );

program
  .command("auth:authjs")
  .description("Mint an Auth.js v5 JWT session cookie storageState without a UI login.")
  .requiredOption("--email <email>", "Auth.js session email")
  .option("--role <role>", "Role id", "member")
  .requiredOption("--base-url <url>", "Target app base URL for the Playwright cookie")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--output <path>", "StorageState output path")
  .option("--user-id <id>", "Stable Auth.js token subject")
  .option("--name <name>", "Display name for the JWT session token")
  .option("--secret <secret>", "Auth.js AUTH_SECRET; defaults to AUTH_SECRET or NEXTAUTH_SECRET from env")
  .option("--cookie-name <name>", "Override the Auth.js session cookie name")
  .option("--secure-cookie", "Use the __Secure-authjs.session-token cookie name")
  .option("--ttl-seconds <seconds>", "Session max age", "3600")
  .action(
    async (options: {
      email: string;
      role: string;
      baseUrl: string;
      cwd: string;
      output?: string;
      userId?: string;
      name?: string;
      secret?: string;
      cookieName?: string;
      secureCookie?: boolean;
      ttlSeconds: string;
    }) => {
      const ttlSeconds = Number.parseInt(options.ttlSeconds, 10);
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        program.error("--ttl-seconds must be a positive integer.");
      }
      const output = storageStatePathFor(options.cwd, options.role, options.output);
      const result = await new AuthJsAuthAdapter().mintSession({
        role: options.role,
        email: options.email,
        appBaseUrl: options.baseUrl,
        storageStatePath: output,
        userId: options.userId,
        name: options.name,
        secret: options.secret,
        cookieName: options.cookieName,
        secureCookie: options.secureCookie,
        ttlSeconds
      });
      console.log(
        JSON.stringify(
          {
            command: "auth:authjs",
            role: result.role,
            email: result.email,
            subject: result.subject,
            cookieName: result.cookieName,
            storageState: result.storageStatePath,
            appOrigin: result.appOrigin,
            expiresAt: result.expiresAt
          },
          null,
          2
        )
      );
    }
  );

program
  .command("auth:clerk")
  .description("Mint a Clerk test-mode storageState from a testing token and +clerk_test email.")
  .requiredOption("--email <email>", "Clerk test email; must include +clerk_test")
  .requiredOption("--testing-token <token>", "Short-lived Clerk testing token")
  .requiredOption("--base-url <url>", "Target app base URL for the Playwright storage origin")
  .option("--role <role>", "Role id", "member")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--output <path>", "StorageState output path")
  .option("--publishable-key <key>", "Optional Clerk publishable key recorded as non-secret test metadata")
  .action(
    async (options: {
      email: string;
      testingToken: string;
      baseUrl: string;
      role: string;
      cwd: string;
      output?: string;
      publishableKey?: string;
    }) => {
      const output = storageStatePathFor(options.cwd, options.role, options.output);
      const result = await new ClerkAuthAdapter().mintSession({
        role: options.role,
        email: options.email,
        appBaseUrl: options.baseUrl,
        storageStatePath: output,
        testingToken: options.testingToken,
        publishableKey: options.publishableKey
      });
      console.log(
        JSON.stringify(
          {
            command: "auth:clerk",
            role: result.role,
            email: result.email,
            storageState: result.storageStatePath,
            appOrigin: result.appOrigin,
            testingTokenQueryParam: result.testingTokenQueryParam
          },
          null,
          2
        )
      );
    }
  );

program
  .command("auth:firebase")
  .description("Mint a Firebase Auth emulator storageState without a UI login.")
  .requiredOption("--email <email>", "Firebase Auth emulator email")
  .requiredOption("--password <password>", "Firebase Auth emulator password")
  .requiredOption("--base-url <url>", "Target app base URL for the Playwright storage origin")
  .option("--role <role>", "Role id", "member")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--output <path>", "StorageState output path")
  .option("--project-id <id>", "Firebase project id; defaults to env or ghost-invasion-local")
  .option("--api-key <key>", "Firebase Web API key; defaults to fake-api-key for the emulator", "fake-api-key")
  .option("--emulator-url <url>", "Firebase Auth emulator URL; defaults to FIREBASE_AUTH_EMULATOR_HOST or 127.0.0.1:9099")
  .action(
    async (options: {
      email: string;
      password: string;
      baseUrl: string;
      role: string;
      cwd: string;
      output?: string;
      projectId?: string;
      apiKey: string;
      emulatorUrl?: string;
    }) => {
      const output = storageStatePathFor(options.cwd, options.role, options.output);
      const result = await new FirebaseAuthAdapter({
        projectId: options.projectId,
        apiKey: options.apiKey,
        emulatorUrl: options.emulatorUrl
      }).mintSession({
        role: options.role,
        email: options.email,
        password: options.password,
        appBaseUrl: options.baseUrl,
        storageStatePath: output
      });
      console.log(
        JSON.stringify(
          {
            command: "auth:firebase",
            role: result.role,
            email: result.email,
            uid: result.uid,
            storageState: result.storageStatePath,
            appOrigin: result.appOrigin,
            storageKey: result.storageKey,
            emulatorUrl: result.emulatorUrl
          },
          null,
          2
        )
      );
    }
  );

const supabase = program.command("supabase").description("Inspect or run the Supabase-local auth/seed adapter.");

supabase
  .command("isolation")
  .description("Verify the Supabase-local stack is safe for supabase-db-reset mutating runs.")
  .option("--cwd <path>", "Project root", process.cwd())
  .action(async (options: { cwd: string }) => {
    const verdict = await new SupabaseSeedAdapter({ projectRoot: options.cwd }).isolation();
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.ok) process.exitCode = 1;
  });

supabase
  .command("reset")
  .description("Run supabase db reset --local through the SeedAdapter.")
  .option("--cwd <path>", "Project root", process.cwd())
  .action(async (options: { cwd: string }) => {
    const result = await new SupabaseSeedAdapter({ projectRoot: options.cwd }).reset();
    console.log(JSON.stringify({ command: "supabase reset", code: result.code }, null, 2));
  });

const config = program.command("config").description("Manage ghost-invasion project configuration.");

config
  .command("reset")
  .description("Register the reset command that protects mutating runs.")
  .requiredOption("--command <command>", "User-owned reset command")
  .option("--seed-command <command>", "Optional seed command to run after reset")
  .option("--cwd <path>", "Project root", process.cwd())
  .action(async (options: { command: string; seedCommand?: string; cwd: string }) => {
    const result = await writeUserResetConfig({
      projectRoot: options.cwd,
      command: options.command,
      seedCommand: options.seedCommand
    });
    console.log(
      JSON.stringify(
        {
          command: "config reset",
          reset: result.paths.resetConfig,
          plan: result.plan ? result.paths.plan : null,
          resetStrategy: result.reset.strategy,
          isolation: result.reset.isolation,
          runsBefore: result.reset.runsBefore,
          runsAfter: result.reset.runsAfter
        },
        null,
        2
      )
    );
  });

config
  .command("supabase-reset")
  .description("Register Supabase-local db reset as the mutating-run reset boundary.")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--verify", "Fail unless the Supabase-local stack is currently reachable")
  .action(async (options: { cwd: string; verify?: boolean }) => {
    if (options.verify) {
      const verdict = await new SupabaseSeedAdapter({ projectRoot: options.cwd }).isolation();
      if (!verdict.ok) {
        console.error(verdict.reasons.join("\n"));
        process.exitCode = 1;
        return;
      }
    }
    const result = await writeSupabaseResetConfig({ projectRoot: options.cwd });
    console.log(
      JSON.stringify(
        {
          command: "config supabase-reset",
          reset: result.paths.resetConfig,
          plan: result.plan ? result.paths.plan : null,
          resetStrategy: result.reset.strategy,
          isolation: result.reset.isolation,
          runsBefore: result.reset.runsBefore,
          runsAfter: result.reset.runsAfter
        },
        null,
        2
      )
    );
  });

// Top-level handler: a thrown prerequisite error (e.g. `repro` before `shrink`) must exit
// non-zero with a one-line message, never a raw Node stack trace (S-043). Commander's own
// usage/validation errors already print and exit on their own and do not reach here.
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
