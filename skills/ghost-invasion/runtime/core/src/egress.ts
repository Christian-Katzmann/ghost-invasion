import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EgressCanaryProof {
  mode: "container-firewall";
  proven: boolean;
  canaryMatrix: Record<string, string>;
  allowlist: string[];
  dockerAvailable: boolean;
  errors: string[];
}

export const defaultEgressAllowlist = [
  "localhost",
  "127.0.0.1",
  "mailpit:1025",
  "mailpit:8025",
  "supabase-mailpit:54324",
  "s3-stub",
  "webhook-sink",
  "localstripe"
] as const;

// Egress-prefixed so the (uncurated `export *`) public barrel does not collide with the
// identically-shaped CommandResult/CommandRunner exported by supabase-adapter.ts.
export interface EgressCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// A command runner is injectable so the egress proof can be exercised under test
// without a Docker daemon (and so a regression that makes `proven` true on an
// escaped canary, or drops the containment flags, is caught in CI).
export type EgressCommandRunner = (command: string, args: string[], timeoutMs: number) => Promise<EgressCommandResult>;

export interface CanaryMatrixDeps {
  runCommand?: EgressCommandRunner;
  env?: NodeJS.ProcessEnv;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<EgressCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL", stdout, stderr, timedOut: true });
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
      resolve({ code: 127, signal: null, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut: false });
    });
  });
}

export async function checkDockerAvailable(
  run: EgressCommandRunner = runCommand
): Promise<{ available: boolean; detail: string }> {
  const result = await run("docker", ["info", "--format", "{{json .ServerVersion}}"], 5_000);
  if (result.code === 0) {
    return { available: true, detail: result.stdout.trim() || "docker daemon responded" };
  }
  const detail = (result.stderr || result.stdout || "docker daemon did not respond").trim();
  return { available: false, detail };
}

const canaryScript = String.raw`
const http = require("node:http");
const https = require("node:https");

function requestWith(module, url) {
  return new Promise((resolve, reject) => {
    const req = module.request(url, { timeout: 2500 }, (res) => {
      res.resume();
      res.on("end", () => resolve({ statusCode: res.statusCode }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

async function run(label, operation) {
  try {
    await operation();
    return [label, "escaped"];
  } catch (error) {
    return [label, "blocked"];
  }
}

(async () => {
  const entries = [];
  entries.push(await run("fetch:ghost-canary", () => fetch("https://ghost-canary.invalid")));
  entries.push(await run("fetch:fake-stripe", () => fetch("https://api.stripe.com/v1/charges", { method: "POST" })));
  entries.push(await run("https.request:ghost-canary", () => requestWith(https, "https://ghost-canary.invalid/")));
  entries.push(await run("http.request:ghost-canary", () => requestWith(http, "http://ghost-canary.invalid/")));
  console.log(JSON.stringify(Object.fromEntries(entries)));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;

// Canary / target base image.
//
// The integrity of the egress proof rides on whatever the image tag resolves to at
// pull time, so a floating tag weakens reproducibility (S-016). We default to the
// `node:22-alpine` tag for out-of-the-box use, but expose GHOST_INVASION_CANARY_IMAGE
// so an operator can pin an immutable digest — e.g.
//   GHOST_INVASION_CANARY_IMAGE='node:22-alpine@sha256:<digest>'
// which is the recommended setup for air-gapped or audited runs. Resolve a digest with:
//   docker buildx imagetools inspect node:22-alpine
// A wrong/unreachable pin is fail-closed (the canary cannot run → proven:false), never
// a silent escape.
const defaultCanaryBaseImage = "node:22-alpine";

export function canaryBaseImage(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GHOST_INVASION_CANARY_IMAGE?.trim();
  return override && override.length > 0 ? override : defaultCanaryBaseImage;
}

// The only statuses the in-container canary can report per probe. Anything outside
// this set (or an empty matrix, or non-JSON stdout) means we cannot trust the proof,
// so we treat it as unproven — mirroring the `code !== 0` fail-closed branch.
const canaryProbeStatuses = new Set(["blocked", "escaped"]);

type ParsedCanaryMatrix =
  | { ok: true; matrix: Record<string, string> }
  | { ok: false; error: string };

function parseCanaryMatrix(stdout: string): ParsedCanaryMatrix {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    return { ok: false, error: `canary stdout was not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "canary stdout was not a JSON object" };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: "canary matrix was empty (zero probes ran)" };
  }
  for (const [label, status] of entries) {
    if (typeof status !== "string" || !canaryProbeStatuses.has(status)) {
      return { ok: false, error: `canary probe "${label}" reported an unexpected status` };
    }
  }
  return { ok: true, matrix: parsed as Record<string, string> };
}

function proofFromFailure(message: string): EgressCanaryProof {
  return {
    mode: "container-firewall",
    proven: false,
    canaryMatrix: { docker: "not-run:daemon-unavailable" },
    allowlist: [...defaultEgressAllowlist],
    dockerAvailable: false,
    errors: [message]
  };
}

export async function runContainerCanaryMatrix(deps: CanaryMatrixDeps = {}): Promise<EgressCanaryProof> {
  const run = deps.runCommand ?? runCommand;
  const env = deps.env ?? process.env;
  const docker = await checkDockerAvailable(run);
  if (!docker.available) {
    return proofFromFailure(docker.detail);
  }

  const dir = await mkdtemp(join(tmpdir(), "ghost-invasion-canary-"));
  try {
    const scriptPath = join(dir, "canary.cjs");
    await writeFile(scriptPath, canaryScript, "utf8");
    const result = await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${dir}:/canary:ro`,
        canaryBaseImage(env),
        "node",
        "/canary/canary.cjs"
      ],
      45_000
    );

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || "docker canary failed").trim();
      return {
        mode: "container-firewall",
        proven: false,
        canaryMatrix: { docker: "canary-failed" },
        allowlist: [...defaultEgressAllowlist],
        dockerAvailable: true,
        errors: [detail]
      };
    }

    // Fail closed on an empty/garbled/non-enum matrix or a JSON.parse throw: a proof we
    // cannot read is not a proof. (Previously a bare cast made `{}` yield proven:true.)
    const parsed = parseCanaryMatrix(result.stdout);
    if (!parsed.ok) {
      return {
        mode: "container-firewall",
        proven: false,
        canaryMatrix: { docker: "canary-unreadable" },
        allowlist: [...defaultEgressAllowlist],
        dockerAvailable: true,
        errors: [parsed.error]
      };
    }

    const escaped = Object.values(parsed.matrix).some((status) => status === "escaped");
    return {
      mode: "container-firewall",
      proven: !escaped,
      canaryMatrix: parsed.matrix,
      allowlist: [...defaultEgressAllowlist],
      dockerAvailable: true,
      errors: escaped ? ["at least one canary escaped the container firewall"] : []
    };
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

export function buildInternalDockerNetworkCommand(networkName = "ghost-invasion-trap"): string[] {
  return ["docker", "network", "create", "--driver", "bridge", "--internal", networkName];
}

export interface ContainerFirewallRunOptions {
  command: string;
  containerPort: number;
  hostPort: number;
  image?: string;
  name?: string;
  networkName?: string;
  workspace?: string;
}

export function buildContainerFirewallRunCommand(options: ContainerFirewallRunOptions): string[] {
  const image = options.image ?? canaryBaseImage();
  const networkName = options.networkName ?? "ghost-invasion-trap";
  const workspace = options.workspace ?? process.cwd();
  const name = options.name ?? `ghost-target-${Date.now()}`;
  return [
    "docker",
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    networkName,
    "-p",
    `127.0.0.1:${options.hostPort}:${options.containerPort}`,
    "-v",
    `${workspace}:/workspace:ro`,
    "-w",
    "/workspace",
    image,
    "sh",
    "-lc",
    options.command
  ];
}
