import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { latticeagConfigSchema } from "@latticeag/config";
import { AGENT_STUB, ENV_EXAMPLE } from "./env-example.js";
import { runCli } from "../test-spawn.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "latticeag-init-"));
}

describe("latticeag init", () => {
  it("scaffolds a temp dir and latticeag.json parses with the config schema", async () => {
    const dir = tempDir();
    const result = await runCli(
      ["init", dir, "--template", "blank", "--adapters", "axion"],
      { env: { LATTICEAG_CONFIG: "" } },
    );
    expect(result.stderr, result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`initialized ${dir}`);
    expect(result.stdout).toContain("wrote latticeag.json");
    expect(result.stdout).toContain("enabled adapters: axion");
    expect(result.stdout).toContain(
      "next: cp .env.example .env && latticeag doctor",
    );

    const configPath = path.join(dir, "latticeag.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    const parsed = latticeagConfigSchema.parse(raw);
    expect(parsed.schema_version).toBe(1);
    expect(parsed.project.name).toBe(path.basename(dir));
    expect(parsed.$schema).toBe(
      "https://latticeag.dev/schemas/latticeag-config/v1.json",
    );
    expect(parsed.adapters.axion.enabled).toBe(true);
    expect(parsed.adapters.visreplay.enabled).toBe(false);
    expect(parsed.adapters.lexverdict.enabled).toBe(false);
    expect(parsed.adapters.vekinbox.enabled).toBe(false);
    expect(parsed.adapters.axion.base_url).toBe("http://127.0.0.1:8787");
    expect(parsed.adapters.visreplay.session_dir).toBe(".latticeag/sessions");
    expect(parsed.ingest.bind).toBe("127.0.0.1");
    expect(parsed.sync.enabled).toBe(false);
    expect(existsSync(path.join(dir, ".latticeag", ".gitkeep"))).toBe(true);
    expect(readFileSync(path.join(dir, ".env.example"), "utf8")).toBe(
      ENV_EXAMPLE,
    );
    expect(readFileSync(path.join(dir, "src", "agent.ts"), "utf8")).toBe(
      AGENT_STUB,
    );
    expect(existsSync(path.join(dir, ".gitignore"))).toBe(true);
  });

  it("refuses an existing latticeag.json unless --force", async () => {
    const dir = tempDir();
    const first = await runCli(["init", dir, "--template", "blank"]);
    expect(first.status).toBe(0);
    const second = await runCli(["init", dir, "--template", "blank"]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already exists/);
    const forced = await runCli([
      "init",
      dir,
      "--template",
      "blank",
      "--adapters",
      "viscompile",
      "--force",
    ]);
    expect(forced.status).toBe(0);
    const parsed = latticeagConfigSchema.parse(
      JSON.parse(readFileSync(path.join(dir, "latticeag.json"), "utf8")) as unknown,
    );
    expect(parsed.adapters.viscompile.enabled).toBe(true);
    expect(parsed.adapters.axion.enabled).toBe(false);
  });

  it("unknown adapter slug exits 1", async () => {
    const dir = tempDir();
    const result = await runCli([
      "init",
      dir,
      "--template",
      "blank",
      "--adapters",
      "not-a-product",
    ]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toMatch(/unknown adapter slug/);
  });

  it("--json prints InitResult", async () => {
    const dir = tempDir();
    const result = await runCli([
      "init",
      dir,
      "--template",
      "blank",
      "--adapters",
      "axion,visreplay",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      data: { dir: string; adapters_enabled: string[]; template: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.command).toBe("init");
    expect(envelope.data.dir).toBe(dir);
    expect(envelope.data.template).toBe("blank");
    expect(envelope.data.adapters_enabled).toEqual(["axion", "visreplay"]);
  });

  it("demo template copies examples/runs-on-latticeag", async () => {
    const dir = tempDir();
    const result = await runCli(["init", dir, "--template", "demo"]);
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(existsSync(path.join(dir, "src", "agent.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "src", "assert-chain.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "fixtures", "beliefs.json"))).toBe(true);
    expect(existsSync(path.join(dir, "latticeag.json"))).toBe(true);
  });

  it("does not leave a half-written config when dir is a file", async () => {
    const dir = tempDir();
    const filePath = path.join(dir, "as-file");
    writeFileSync(filePath, "nope");
    const result = await runCli(["init", filePath, "--template", "blank"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/exists as a file/);
  });
});
