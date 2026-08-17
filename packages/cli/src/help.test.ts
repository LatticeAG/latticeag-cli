import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./test-spawn.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function snapshot(rel: string): string {
  return readFileSync(path.join(here, rel), "utf8");
}

const INIT_FLAGS = [
  "--template",
  "--adapters",
  "--force",
  "--git",
  "--no-git",
  "--json",
  "--config",
  "--cwd",
  "--quiet",
  "--verbose",
  "--no-color",
  "-h",
  "--help",
  "-V",
  "--version",
];

const DOCTOR_FLAGS = [
  "--offline",
  "--fix",
  "--json",
  "--config",
  "--cwd",
  "--quiet",
  "--verbose",
  "--no-color",
  "-h",
  "--help",
  "-V",
  "--version",
];

const VERSION_FLAGS = [
  "--json",
  "--config",
  "--cwd",
  "--quiet",
  "--verbose",
  "--no-color",
  "-h",
  "--help",
  "-V",
  "--version",
];

const PRODUCTS_FLAGS = [
  "--status",
  "--json",
  "--config",
  "--cwd",
  "--quiet",
  "--verbose",
  "--no-color",
  "-h",
  "--help",
  "-V",
  "--version",
];

const RUN_FLAGS = [
  "--cmd",
  "--attach",
  "--adapters",
  "--env-file",
  "--timeout-ms",
  "--run-id",
  "--session-id",
  "--fixture-beliefs",
  "--fixture-approvals",
  "--fail-on-sync",
  "--json",
  "--config",
  "--cwd",
  "--quiet",
  "--verbose",
  "--no-color",
  "-h",
  "--help",
  "-V",
  "--version",
];

const DEV_FLAGS = [...RUN_FLAGS, "--follow-types"];

const EVENTS_FLAGS = [
  "--follow",
  "--replay",
  "--from-seq",
  "--type",
  "--run-id",
  "--session-id",
  "--format",
  "--strict-names",
  "--no-redact",
  "--limit",
  "--json",
  "--config",
  "--cwd",
  "--quiet",
  "--verbose",
  "--no-color",
  "-h",
  "--help",
  "-V",
  "--version",
];

describe("help snapshots", () => {
  it("root --help matches snapshot and tagline", async () => {
    const result = await runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("cli.help.txt"));
    expect(result.stdout).toContain(
      "The LatticeAG stack as one command. Every product event, one schema.",
    );
    expect(result.stdout).toMatch(/\binit\b/);
    expect(result.stdout).toMatch(/\brun\b/);
    expect(result.stdout).toMatch(/\bdev\b/);
    expect(result.stdout).toMatch(/\bevents\b/);
    expect(result.stdout).toMatch(/\bdoctor\b/);
    expect(result.stdout).toMatch(/\bproducts\b/);
    expect(result.stdout).toMatch(/\bversion\b/);
  });

  it("init --help matches snapshot and includes section 7 flags", async () => {
    const result = await runCli(["init", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("commands/init.help.txt"));
    for (const flag of INIT_FLAGS) {
      expect(result.stdout, `missing ${flag}`).toContain(flag);
    }
  });

  it("doctor --help matches snapshot and includes section 7 flags", async () => {
    const result = await runCli(["doctor", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("commands/doctor.help.txt"));
    for (const flag of DOCTOR_FLAGS) {
      expect(result.stdout, `missing ${flag}`).toContain(flag);
    }
  });

  it("version --help matches snapshot and includes section 7 flags", async () => {
    const result = await runCli(["version", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("commands/version.help.txt"));
    for (const flag of VERSION_FLAGS) {
      expect(result.stdout, `missing ${flag}`).toContain(flag);
    }
  });

  it("products --help matches snapshot and includes section 7 flags", async () => {
    const result = await runCli(["products", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("commands/products.help.txt"));
    for (const flag of PRODUCTS_FLAGS) {
      expect(result.stdout, `missing ${flag}`).toContain(flag);
    }
  });

  it("run --help matches snapshot and includes section 7 flags", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("commands/run.help.txt"));
    for (const flag of RUN_FLAGS) {
      expect(result.stdout, `missing ${flag}`).toContain(flag);
    }
  });

  it("dev --help matches snapshot and includes section 7 flags", async () => {
    const result = await runCli(["dev", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("commands/dev.help.txt"));
    for (const flag of DEV_FLAGS) {
      expect(result.stdout, `missing ${flag}`).toContain(flag);
    }
  });

  it("events --help matches snapshot and includes section 7 flags", async () => {
    const result = await runCli(["events", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(snapshot("commands/events.help.txt"));
    for (const flag of EVENTS_FLAGS) {
      expect(result.stdout, `missing ${flag}`).toContain(flag);
    }
  });

  it("-V prints CLI semver only", async () => {
    const result = await runCli(["-V"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.1.0\n");
  });

  it("--verbose and --quiet together exit 1", async () => {
    const result = await runCli(["--verbose", "--quiet", "version"]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain(
      "flags --verbose and --quiet are mutually exclusive",
    );
  });
});
