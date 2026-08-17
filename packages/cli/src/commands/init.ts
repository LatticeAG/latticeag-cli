import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { Option } from "commander";
import {
  CONFIG_FILENAME,
  DEFAULT_ADAPTERS_LIST,
  LATTICEAG_CONFIG_SCHEMA_URL,
  createDefaultConfig,
  enabledAdapters,
  parseAdapterList,
  UnknownAdapterError,
  type AdapterName,
} from "@latticeag/config";
import { addGlobalOptions, readGlobalOpts } from "../globals.js";
import { fail, writeJson } from "../json-envelope.js";
import { AGENT_STUB, ENV_EXAMPLE, GITIGNORE_RULES } from "./env-example.js";

export interface InitResult {
  dir: string;
  config_path: string;
  template: "blank" | "demo";
  adapters_enabled: string[];
  gitignore_updated: boolean;
}

function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (
      existsSync(path.join(dir, "pnpm-workspace.yaml")) &&
      existsSync(path.join(dir, "packages"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function assertSafeInitDir(absDir: string): string | undefined {
  const parts = absDir.split(path.sep);
  if (parts.includes("node_modules")) {
    return "refusing to write inside node_modules";
  }
  if (parts.includes(".git")) {
    return "refusing to write inside .git";
  }
  if (
    path.basename(absDir) === "packages" &&
    existsSync(path.join(absDir, "events"))
  ) {
    return "refusing to write inside a packages directory that already contains events";
  }
  return undefined;
}

function appendGitignore(dir: string): boolean {
  const gitignorePath = path.join(dir, ".gitignore");
  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, "utf8");
  }
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missing = GITIGNORE_RULES.filter((rule) => !existingLines.has(rule));
  if (missing.length === 0) {
    return false;
  }
  const prefix =
    existing.length === 0
      ? "# latticeag\n"
      : existing.endsWith("\n")
        ? "\n# latticeag\n"
        : "\n\n# latticeag\n";
  writeFileSync(gitignorePath, `${existing}${prefix}${missing.join("\n")}\n`);
  return true;
}

function copyDemoTemplate(dest: string): string | undefined {
  const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!repoRoot) {
    return "demo template not found: could not locate the latticeag repo root (examples/runs-on-latticeag)";
  }
  const src = path.join(repoRoot, "examples", "runs-on-latticeag");
  if (!existsSync(src)) {
    return `demo template not found: expected ${src}`;
  }
  cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const rel = path.relative(src, from);
      return !rel.split(path.sep).includes("node_modules");
    },
  });
  return undefined;
}

export async function runInit(
  dirArg: string,
  raw: {
    template?: string;
    adapters?: string;
    force?: boolean;
    git?: boolean;
    json?: boolean;
  },
): Promise<void> {
  const json = raw.json === true;
  const template = raw.template === "demo" ? "demo" : "blank";
  if (raw.template && raw.template !== "blank" && raw.template !== "demo") {
    fail(`unknown template: ${raw.template}`, {
      json,
      command: "init",
      code: "USAGE",
    });
  }

  let adapters: AdapterName[];
  try {
    adapters = parseAdapterList(raw.adapters ?? DEFAULT_ADAPTERS_LIST);
  } catch (err) {
    if (err instanceof UnknownAdapterError) {
      fail(`unknown adapter slug: ${err.slug}`, {
        json,
        command: "init",
        code: "USAGE",
      });
    }
    throw err;
  }

  const absDir = path.resolve(dirArg);
  const unsafe = assertSafeInitDir(absDir);
  if (unsafe) {
    fail(unsafe, { json, command: "init", code: "USAGE" });
  }

  if (existsSync(absDir)) {
    const st = statSync(absDir);
    if (st.isFile()) {
      fail(`dir exists as a file: ${absDir}`, {
        json,
        command: "init",
        code: "USAGE",
      });
    }
  } else {
    mkdirSync(absDir, { recursive: true });
  }

  const configPath = path.join(absDir, CONFIG_FILENAME);
  if (existsSync(configPath) && raw.force !== true) {
    fail(`latticeag.json already exists (use --force to overwrite)`, {
      json,
      command: "init",
      code: "USAGE",
    });
  }

  if (template === "demo") {
    const copyErr = copyDemoTemplate(absDir);
    if (copyErr) {
      fail(copyErr, { json, command: "init", code: "USAGE" });
    }
  }

  const projectName = path.basename(absDir);
  const config = createDefaultConfig(projectName, adapters);
  writeFileSync(
    configPath,
    `${JSON.stringify(config, null, 2)}\n`.replace(
      /https:\/\/latticeag\.dev\/schemas\/latticeag-config\/v1\.json/,
      LATTICEAG_CONFIG_SCHEMA_URL,
    ),
  );

  mkdirSync(path.join(absDir, ".latticeag"), { recursive: true });
  const gitkeep = path.join(absDir, ".latticeag", ".gitkeep");
  if (!existsSync(gitkeep)) {
    writeFileSync(gitkeep, "");
  }

  const envExamplePath = path.join(absDir, ".env.example");
  if (!existsSync(envExamplePath) || template === "blank") {
    writeFileSync(envExamplePath, ENV_EXAMPLE);
  }

  if (template === "blank") {
    mkdirSync(path.join(absDir, "src"), { recursive: true });
    const agentPath = path.join(absDir, "src", "agent.ts");
    if (!existsSync(agentPath) || raw.force === true) {
      writeFileSync(agentPath, AGENT_STUB);
    }
  }

  const gitEnabled = raw.git !== false;
  let gitignoreUpdated = false;
  if (gitEnabled) {
    gitignoreUpdated = appendGitignore(absDir);
  }

  const adaptersEnabled = enabledAdapters(config);
  const result: InitResult = {
    dir: absDir,
    config_path: configPath,
    template,
    adapters_enabled: adaptersEnabled,
    gitignore_updated: gitignoreUpdated,
  };

  if (json) {
    writeJson("init", true, result);
    return;
  }

  const lines = [
    `initialized ${absDir}`,
    `wrote latticeag.json`,
    `enabled adapters: ${adaptersEnabled.join(", ")}`,
    `next: cp .env.example .env && latticeag doctor`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function registerInit(program: Command): void {
  const cmd = program
    .command("init")
    .description("Scaffold a project.")
    .argument("[dir]", "Directory to initialize", ".")
    .addOption(
      new Option("--template <blank|demo>", "blank or demo template")
        .choices(["blank", "demo"])
        .default("blank"),
    )
    .option(
      "--adapters <list>",
      "Comma list of slugs to set enabled: true",
      DEFAULT_ADAPTERS_LIST,
    )
    .option("--force", "Overwrite latticeag.json")
    .addOption(
      new Option("--git", "Append latticeag ignore rules to .gitignore").default(
        true,
      ),
    )
    .option("--no-git", "Skip gitignore edit")
    .action(async (dir: string, opts: Record<string, unknown>, command: Command) => {
      const globals = readGlobalOpts(command);
      await runInit(dir, {
        template: opts.template as string | undefined,
        adapters: opts.adapters as string | undefined,
        force: opts.force === true,
        git: opts.git as boolean | undefined,
        json: globals.json === true,
      });
    });
  addGlobalOptions(cmd);
}
