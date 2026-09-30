import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultContractYaml } from "./contracts.js";

export interface GhostLayoutPaths {
  root: string;
  config: string;
  contracts: string;
  contractPacks: string;
  plan: string;
  runtimeAuth: string;
  scripts: string;
  runs: string;
}

const starterFiles: Array<{ path: string; content: string }> = [
  {
    path: "config/ghost.config.json",
    content: JSON.stringify(
      {
        schemaVersion: "1.0",
        adapter: "manual",
        auth: "generic",
        baseUrl: null,
        defaultMode: "quick",
        defaultPack: "launch-readiness"
      },
      null,
      2
    ) + "\n"
  },
  {
    path: "config/reset.json",
    content: JSON.stringify(
      {
        schemaVersion: "1.0",
        strategy: "none",
        isolation: "unknown",
        resetCommand: null,
        seedCommand: null,
        runsBefore: [],
        runsAfter: [],
        destructiveAllowed: false,
        userOwnedBoundary: false,
        updatedAt: "not-configured"
      },
      null,
      2
    ) + "\n"
  },
  {
    path: "config/service-mocks.json",
    content: JSON.stringify(
      {
        schemaVersion: "1.0",
        allowlist: ["localhost", "127.0.0.1"],
        services: []
      },
      null,
      2
    ) + "\n"
  },
  {
    path: "config/safe-env.example",
    content: "# Safe placeholders only. Never put live production secrets in this file.\n"
  },
  {
    path: "contracts/ghost.contract.yaml",
    content: defaultContractYaml()
  },
  { path: "plan/discovered-surfaces.md", content: "# Discovered Surfaces\n\nNo scan has run yet.\n" },
  { path: "plan/personas.md", content: "# Personas\n\nNo plan has been compiled yet.\n" },
  { path: "plan/journeys.md", content: "# Journeys\n\nNo plan has been compiled yet.\n" }
];

export async function ensureGhostLayout(projectRoot = process.cwd()): Promise<GhostLayoutPaths> {
  const root = join(projectRoot, ".ghost");
  const paths: GhostLayoutPaths = {
    root,
    config: join(root, "config"),
    contracts: join(root, "contracts"),
    contractPacks: join(root, "contracts", "packs"),
    plan: join(root, "plan"),
    runtimeAuth: join(root, "runtime", "auth"),
    scripts: join(root, "scripts"),
    runs: join(root, "runs")
  };

  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));

  for (const file of starterFiles) {
    await writeFile(join(root, file.path), file.content, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
  }

  return paths;
}
