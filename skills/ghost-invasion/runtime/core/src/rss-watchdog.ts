import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface RssWatchdogShedEvent {
  rssMb: number;
  from: number;
  to: number;
  at: string;
}

export interface RssWatchdogSnapshot {
  maxRssMb: number;
  initialConcurrency: number;
  currentConcurrency: number;
  minConcurrency: number;
  shedEvents: RssWatchdogShedEvent[];
  lastRssMb: number | null;
}

export interface RssConcurrencyWatchdogOptions {
  initialConcurrency: number;
  maxRssMb?: number;
  minConcurrency?: number;
  sampleIntervalMs?: number;
  readRssMb: () => Promise<number>;
  onShed?: (event: RssWatchdogShedEvent) => void | Promise<void>;
}

export class RssConcurrencyWatchdog {
  private readonly maxRssMb: number;
  private readonly minConcurrency: number;
  private readonly sampleIntervalMs: number;
  private readonly readRssMb: () => Promise<number>;
  private readonly onShed?: (event: RssWatchdogShedEvent) => void | Promise<void>;
  private readonly initialConcurrency: number;
  private currentConcurrency: number;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  private lastRssMb: number | null = null;
  private readonly shedEvents: RssWatchdogShedEvent[] = [];

  constructor(options: RssConcurrencyWatchdogOptions) {
    this.initialConcurrency = Math.max(1, Math.floor(options.initialConcurrency));
    this.currentConcurrency = this.initialConcurrency;
    this.minConcurrency = Math.max(1, Math.min(options.minConcurrency ?? 2, this.initialConcurrency));
    this.maxRssMb = options.maxRssMb ?? 6_144;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 1_000;
    this.readRssMb = options.readRssMb;
    this.onShed = options.onShed;
  }

  get limit(): number {
    return this.currentConcurrency;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sampleOnce().catch(() => undefined);
    }, this.sampleIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async sampleOnce(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const rssMb = await this.readRssMb();
      this.lastRssMb = rssMb;
      if (rssMb <= this.maxRssMb || this.currentConcurrency <= this.minConcurrency) return;
      const from = this.currentConcurrency;
      const to = Math.max(this.minConcurrency, from > 4 ? 4 : from - 1);
      if (to >= from) return;
      this.currentConcurrency = to;
      const event = { rssMb, from, to, at: new Date().toISOString() };
      this.shedEvents.push(event);
      await this.onShed?.(event);
    } finally {
      this.sampling = false;
    }
  }

  async waitForTurn(workerIndex: number): Promise<void> {
    while (workerIndex >= this.currentConcurrency) {
      await delay(25);
    }
  }

  snapshot(): RssWatchdogSnapshot {
    return {
      maxRssMb: this.maxRssMb,
      initialConcurrency: this.initialConcurrency,
      currentConcurrency: this.currentConcurrency,
      minConcurrency: this.minConcurrency,
      shedEvents: [...this.shedEvents],
      lastRssMb: this.lastRssMb
    };
  }
}

export async function processTreeRssMbByMarker(marker: string): Promise<number> {
  const result = await spawnForOutput("ps", ["-axo", "pid=,ppid=,rss=,command="], 5_000);
  if (result.code !== 0) return 0;

  const rows: Array<{ pid: number; ppid: number; rssKb: number; command: string }> = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] });
    }
  }

  const roots = rows.filter((row) => row.command.includes(marker)).map((row) => row.pid);
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
    for (const childPid of children.get(pid) ?? []) stack.push(childPid);
  }

  return Math.round(totalKb / 1024);
}

function spawnForOutput(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
