import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_SRC = path.join(here, "cli.ts");
export const CLI_PKG_ROOT = path.resolve(here, "..");

export const DUMMY_ADAPTER_ENV: NodeJS.ProcessEnv = {
  LEXVERDICT_URL: "http://127.0.0.1:8789",
  VEKINBOX_URL: "http://127.0.0.1:3001/v1",
  VEKINBOX_API_KEY: "vk_test_ci",
  VEKINBOX_WORKSPACE_ID: "ws_ci",
  VEKINBOX_AGENT_ID: "ag_ci",
  AXION_WEBHOOK_ALLOW_UNSIGNED: "true",
  LATTICEAG_DOCTOR_ALLOW_MISSING_ADAPTERS: "1",
  LATTICEAG_CONFIG: "",
};

function tsxBin(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("tsx/package.json");
  return path.join(path.dirname(pkg), "dist", "cli.mjs");
}

export function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsxBin(), CLI_SRC, ...args],
      {
        cwd: opts.cwd ?? process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          COLUMNS: "80",
          ...opts.env,
        },
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let status = 0;
        if (error) {
          status = typeof error.code === "number" ? error.code : 1;
        }
        resolve({ status, stdout, stderr });
      },
    );
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function initRunProject(dir: string): Promise<void> {
  const init = await runCli(["init", dir, "--template", "blank", "--force"], {
    env: DUMMY_ADAPTER_ENV,
  });
  if (init.status !== 0) {
    throw new Error(`init failed: ${init.stderr}${init.stdout}`);
  }
  const port = await freePort();
  const configPath = path.join(dir, "latticeag.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    ingest: { port: number };
  };
  config.ingest.port = port;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(path.join(dir, "src", "agent.ts"), 'console.log("hello")\n');
}

