import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { chromium, type Browser, type BrowserContext } from "playwright";

export interface MemoryMeasurement {
  contexts: number;
  rssMb: number;
}

export interface MemorySizingReport {
  measuredAt: string;
  baseUrl: string;
  measurements: MemoryMeasurement[];
  totalMemoryMb: number;
  freeMemoryMb: number;
  decision: string;
  maxContexts: number;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr, code: null });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: 127 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

async function matchingProcessTreeRssMb(probeId: string): Promise<number> {
  const result = await runCommand("ps", ["-axo", "pid=,ppid=,rss=,command="], 5_000);
  if (result.code !== 0) {
    throw new Error(`Unable to read process RSS: ${result.stderr.trim()}`);
  }

  const rows: Array<{ pid: number; ppid: number; rssKb: number; command: string }> = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] });
    }
  }

  const roots = rows.filter((row) => row.command.includes(probeId)).map((row) => row.pid);
  const children = new Map<number, number[]>();
  const rssByPid = new Map<number, number>();
  for (const row of rows) {
    rssByPid.set(row.pid, row.rssKb);
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row.pid);
    children.set(row.ppid, siblings);
  }

  let totalKb = 0;
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    totalKb += rssByPid.get(pid) ?? 0;
    for (const childPid of children.get(pid) ?? []) {
      stack.push(childPid);
    }
  }

  return Math.round(totalKb / 1024);
}

async function openProjectlyJourney(browser: Browser, baseUrl: string, contexts: BrowserContext[]): Promise<void> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(new URL("/projects/new", baseUrl).toString(), { waitUntil: "networkidle", timeout: 20_000 });
  await page.getByLabel(/project name/i).fill(`Memory probe ${contexts.length}`);
}

export async function measureChromiumContextRss(baseUrl: string, counts = [1, 2, 4, 8]): Promise<MemorySizingReport> {
  const measurements: MemoryMeasurement[] = [];

  for (const count of counts) {
    const probeId = `ghost-memory-probe-${count}-${Date.now()}`;
    const browser = await chromium.launch({ headless: true, args: [`--${probeId}`] });

    const contexts: BrowserContext[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        await openProjectlyJourney(browser, baseUrl, contexts);
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
      measurements.push({ contexts: count, rssMb: await matchingProcessTreeRssMb(probeId) });
    } finally {
      for (const context of contexts) {
        await context.close().catch(() => undefined);
      }
      await browser.close().catch(() => undefined);
    }
  }

  const eightContext = measurements.find((measurement) => measurement.contexts === 8);
  const maxContexts = eightContext && eightContext.rssMb > 6_144 ? 4 : 8;
  const decision =
    eightContext && eightContext.rssMb > 6_144
      ? "8 contexts exceed the ~6 GB budget; shed to 2-4 contexts and keep the pre-1.57 Chromium pin."
      : "8 contexts stay under the ~6 GB budget; keep the MVP default at 8 contexts with an RSS watchdog fallback.";

  return {
    measuredAt: new Date().toISOString(),
    baseUrl,
    measurements,
    totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(freemem() / 1024 / 1024),
    decision,
    maxContexts
  };
}

export function renderMemorySizingMarkdown(report: MemorySizingReport): string {
  const rows = report.measurements.map((measurement) => `| ${measurement.contexts} | ${measurement.rssMb} MB |`).join("\n");
  return `# Chromium memory spike

Measured: ${report.measuredAt}
Target: ${report.baseUrl}
Machine memory: ${report.freeMemoryMb} MB free / ${report.totalMemoryMb} MB total

| Contexts | RSS |
|---:|---:|
${rows}

Decision: ${report.decision}

Chosen max browser contexts: ${report.maxContexts}
`;
}

export async function writeMemorySizingMarkdown(baseUrl: string, outputPath: string): Promise<MemorySizingReport> {
  const report = await measureChromiumContextRss(baseUrl);
  await writeFile(outputPath, renderMemorySizingMarkdown(report), "utf8");
  return report;
}

export function chooseMachineAwareConcurrency(memoryBudgetMb?: number): number {
  const freeMb = Math.round(freemem() / 1024 / 1024);
  const totalMb = Math.round(totalmem() / 1024 / 1024);
  const budget = memoryBudgetMb ?? 6_144;
  if (freeMb < 768 && totalMb < 4_096) return 0;
  if (freeMb < 768) return 2;
  if (freeMb < 3_000) return 2;
  if (freeMb < budget) return 4;
  return 8;
}
