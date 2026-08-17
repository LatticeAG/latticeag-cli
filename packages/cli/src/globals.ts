import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { CLI_VERSION } from "./cli-version.js";

export interface GlobalOpts {
  config?: string;
  cwd?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export function addGlobalOptions(cmd: Command, withVersion = true): Command {
  cmd
    .option(
      "--config <path>",
      "Path to latticeag.json; sets LATTICEAG_CONFIG for this process",
    )
    .option("--cwd <dir>", "Change working directory before config discovery")
    .option("--json", "Machine JSON on stdout, diagnostics on stderr")
    .option("--quiet", "No stderr except errors")
    .option("--verbose", "Extra stderr progress")
    .option("--no-color", "Disable ANSI color; also honors NO_COLOR");
  if (withVersion) {
    cmd.version(CLI_VERSION, "-V, --version", "Print CLI semver and exit");
  }
  return cmd;
}

export function applyGlobalOpts(opts: GlobalOpts): void {
  if (opts.verbose && opts.quiet) {
    const message = "flags --verbose and --quiet are mutually exclusive";
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          command: "latticeag",
          cli_version: CLI_VERSION,
          data: null,
          error: { code: "USAGE", message },
        })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exit(1);
  }
  if (opts.cwd) {
    const abs = path.resolve(opts.cwd);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      process.stderr.write(`cwd not found: ${opts.cwd}\n`);
      process.exit(1);
    }
    process.chdir(abs);
  }
  if (opts.config) {
    process.env.LATTICEAG_CONFIG = path.resolve(opts.config);
  }
  if (opts.color === false) {
    process.env.NO_COLOR = process.env.NO_COLOR || "1";
  }
}

export function readGlobalOpts(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}
