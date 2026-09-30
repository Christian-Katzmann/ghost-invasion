import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EvidenceEvent {
  ts?: string;
  runId?: string;
  droneId?: string;
  type: string;
  [key: string]: unknown;
}

export interface TraceReservation {
  enabled: boolean;
  fingerprint: string;
  ordinal: number;
  cap: number;
}

export interface EvidenceBusOptions {
  projectRoot: string;
  runId?: string;
  traceCapPerFingerprint?: number;
}

export interface EvidenceBusSummary {
  runId: string;
  runRoot: string;
  eventsPath: string;
  traceReservations: Record<string, number>;
  degraded: boolean;
}

export function createRunId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function sanitizePathSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

export function failureFingerprint(input: {
  journeyId: string;
  personaId: string;
  stepType?: string;
  message: string;
}): string {
  const stableMessage = input.message.replace(/\s+/g, " ").slice(0, 220);
  const digest = createHash("sha256")
    .update(`${input.journeyId}:${input.stepType ?? "unknown"}:${stableMessage}`)
    .digest("hex")
    .slice(0, 12);
  return `${sanitizePathSegment(input.journeyId)}.${sanitizePathSegment(input.stepType ?? "unknown")}.${digest}`;
}

export class EvidenceBus {
  readonly runId: string;
  readonly runRoot: string;
  readonly eventsPath: string;
  readonly evidenceRoot: string;

  private readonly traceCap: number;
  private readonly traceCounts = new Map<string, number>();
  private writeQueue: Promise<void> = Promise.resolve();
  private degraded = false;

  constructor(options: EvidenceBusOptions) {
    this.runId = options.runId ?? createRunId();
    this.runRoot = join(options.projectRoot, ".ghost", "runs", this.runId);
    this.eventsPath = join(this.runRoot, "events.jsonl");
    this.evidenceRoot = join(this.runRoot, "evidence");
    this.traceCap = options.traceCapPerFingerprint ?? 3;
  }

  async init(): Promise<void> {
    await mkdir(this.evidenceRoot, { recursive: true });
    await mkdir(join(this.runRoot, "reproduction-steps"), { recursive: true });
    await mkdir(join(this.runRoot, "generated-tests"), { recursive: true });
    await writeFile(this.eventsPath, "", { flag: "a" });
  }

  droneDir(droneId: string): string {
    return join(this.evidenceRoot, sanitizePathSegment(droneId));
  }

  async ensureDroneDir(droneId: string): Promise<string> {
    const dir = this.droneDir(droneId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async append(event: EvidenceEvent): Promise<void> {
    const fullEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      ...event
    };
    const line = `${JSON.stringify(fullEvent)}\n`;

    // One serialized writer keeps Engine-A's single evidence spine deterministic.
    // Each write is isolated: a failed appendFile marks the run degraded and
    // re-throws to its own caller, but the queue tail is always re-settled so a
    // single full-disk write can never poison every later append/flush.
    const write = this.writeQueue.then(() => this.writeEventLine(line));
    this.writeQueue = write.then(
      () => undefined,
      () => undefined
    );
    return write;
  }

  private async writeEventLine(line: string): Promise<void> {
    try {
      await this.appendToEventsFile(line);
    } catch (error) {
      await this.recordDegraded(error);
      throw error;
    }
  }

  /**
   * Single low-level append to the events spine. Overridable seam so fault-
   * injection tests can fail one write without poisoning the whole queue.
   */
  protected async appendToEventsFile(line: string): Promise<void> {
    await appendFile(this.eventsPath, line, "utf8");
  }

  private async recordDegraded(cause: unknown): Promise<void> {
    if (this.degraded) return;
    this.degraded = true;
    const marker = `${JSON.stringify({
      ts: new Date().toISOString(),
      runId: this.runId,
      type: "evidence-write-degraded",
      message: cause instanceof Error ? cause.message : String(cause)
    })}\n`;
    // Best-effort terminal marker: the spine is already failing, so a marker
    // write that also fails must not throw — the `degraded` flag still stands.
    await this.appendToEventsFile(marker).catch(() => undefined);
  }

  async appendDroneJsonl(droneId: string, fileName: string, event: EvidenceEvent): Promise<void> {
    const dir = await this.ensureDroneDir(droneId);
    const fullEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      droneId,
      ...event
    };
    await appendFile(join(dir, fileName), `${JSON.stringify(fullEvent)}\n`, "utf8");
  }

  reserveTrace(fingerprint: string): TraceReservation {
    const current = this.traceCounts.get(fingerprint) ?? 0;
    if (current >= this.traceCap) {
      return { enabled: false, fingerprint, ordinal: current, cap: this.traceCap };
    }
    const next = current + 1;
    this.traceCounts.set(fingerprint, next);
    return { enabled: true, fingerprint, ordinal: next, cap: this.traceCap };
  }

  async writeDroneJson(droneId: string, fileName: string, value: unknown): Promise<string> {
    const dir = await this.ensureDroneDir(droneId);
    const path = join(dir, fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return path;
  }

  async writeRunJson(fileName: string, value: unknown): Promise<string> {
    const path = join(this.runRoot, fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return path;
  }

  async normalizeVideoArtifact(droneId: string): Promise<string | null> {
    const dir = this.droneDir(droneId);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      return null;
    }

    const webm = entries.find((entry) => entry.endsWith(".webm") && entry !== "video.webm");
    if (!webm) return null;

    const target = join(dir, "video.webm");
    await rename(join(dir, webm), target).catch(() => undefined);
    return target;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  summary(): EvidenceBusSummary {
    return {
      runId: this.runId,
      runRoot: this.runRoot,
      eventsPath: this.eventsPath,
      traceReservations: Object.fromEntries(this.traceCounts),
      degraded: this.degraded
    };
  }
}
