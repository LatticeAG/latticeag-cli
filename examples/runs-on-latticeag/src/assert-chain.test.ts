import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(root, "..");
const repoRoot = path.resolve(pkgRoot, "../..");
const jsonlPath = path.join(pkgRoot, ".latticeag", "events.jsonl");
const outDir = path.join(pkgRoot, "out");

function latticeOnPath(env: NodeJS.ProcessEnv): boolean {
  const dirs = (env.PATH ?? "").split(path.delimiter);
  return dirs.some((dir) => existsSync(path.join(dir, "lattice")));
}

function resolveCli(): { file: string; args: string[] } {
  const dist = path.join(repoRoot, "packages", "cli", "dist", "cli.js");
  if (existsSync(dist)) {
    return { file: process.execPath, args: [dist] };
  }
  const src = path.join(repoRoot, "packages", "cli", "src", "cli.ts");
  const tsx = path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const tsxFallback = path.join(
    repoRoot,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  const loader = existsSync(tsx) ? tsx : tsxFallback;
  return { file: process.execPath, args: [loader, src] };
}

function spawn(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: pkgRoot,
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let status = 0;
        if (error) {
          status = typeof error.code === "number" ? error.code : 1;
        }
        resolve({
          status,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

function eventNames(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return (JSON.parse(line) as { name?: string }).name ?? "?";
      } catch {
        return "?";
      }
    });
}

describe("runs-on-latticeag assert-chain", () => {
  it(
    "runs the offline fixture latticeag run then assert-chain",
    async () => {
      mkdirSync(path.join(pkgRoot, ".latticeag"), { recursive: true });
      if (existsSync(jsonlPath)) {
        unlinkSync(jsonlPath);
      }
      if (existsSync(outDir)) {
        rmSync(outDir, { recursive: true, force: true });
      }

      const cargoBin = path.join(process.env.HOME ?? "", ".cargo", "bin");
      const pathEnv = existsSync(path.join(cargoBin, "lattice"))
        ? `${cargoBin}${path.delimiter}${process.env.PATH ?? ""}`
        : (process.env.PATH ?? "");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: pathEnv,
        LATTICEAG_GOAL:
          "Write production config.yaml with env: production and replicas: 3",
        VEKINBOX_AUTO_APPROVE: "1",
        AXION_WEBHOOK_ALLOW_UNSIGNED: "true",
        LEXVERDICT_URL: "http://127.0.0.1:8789",
        VEKINBOX_URL: "http://127.0.0.1:3001/v1",
        VEKINBOX_API_KEY: "vk_test_ci",
        VEKINBOX_WORKSPACE_ID: "ws_demo",
        VEKINBOX_AGENT_ID: "ag_demo",
        LATTICEAG_CONFIG: "",
      };
      if (!latticeOnPath(env)) {
        env.LATTICEAG_ALLOW_MISSING_DIFF = "1";
      } else {
        delete env.LATTICEAG_ALLOW_MISSING_DIFF;
      }

      const cli = resolveCli();
      const run = await spawn(
        cli.file,
        [
          ...cli.args,
          "run",
          "--fixture-beliefs",
          "fixtures/beliefs.json",
          "--fixture-approvals",
          "fixtures/approvals.json",
          "--attach",
          "custom",
          "--cmd",
          "npx tsx src/agent.ts --offline-fixture",
        ],
        env,
        55_000,
      );
      const names = eventNames(jsonlPath);
      process.stdout.write(
        `event name sequence: ${names.join(", ")}\n`,
      );
      expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0);

      const tsx = path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const tsxFallback = path.join(
        repoRoot,
        "node_modules",
        "tsx",
        "dist",
        "cli.mjs",
      );
      const loader = existsSync(tsx) ? tsx : tsxFallback;
      const assertResult = await spawn(
        process.execPath,
        [loader, path.join(pkgRoot, "src", "assert-chain.ts"), jsonlPath],
        env,
        15_000,
      );
      process.stdout.write(assertResult.stdout);
      expect(
        assertResult.status,
        `${assertResult.stderr}\n${assertResult.stdout}`,
      ).toBe(0);
    },
    60_000,
  );
});
