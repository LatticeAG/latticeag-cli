import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigParseError,
  ConfigSchemaError,
  createDefaultConfig,
  latticeagConfigJsonSchema,
  latticeagConfigSchema,
  loadConfig,
} from "./index.js";

const origConfigEnv = process.env.LATTICEAG_CONFIG;

afterEach(() => {
  if (origConfigEnv === undefined) {
    delete process.env.LATTICEAG_CONFIG;
  } else {
    process.env.LATTICEAG_CONFIG = origConfigEnv;
  }
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "latticeag-config-"));
}

function writeConfig(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "latticeag.json");
  writeFileSync(filePath, body, "utf8");
  return filePath;
}

describe("loadConfig", () => {
  it("walks parent directories from cwd", () => {
    const root = tempDir();
    const child = path.join(root, "a", "b", "c");
    mkdirSync(child, { recursive: true });
    const config = createDefaultConfig("walk-test", ["axion"]);
    writeConfig(root, `${JSON.stringify(config, null, 2)}\n`);
    const loaded = loadConfig(child);
    expect(loaded.path).toBe(path.join(root, "latticeag.json"));
    expect(loaded.from_env).toBe(false);
    expect(loaded.config.project.name).toBe("walk-test");
    expect(loaded.config.adapters.axion.enabled).toBe(true);
  });

  it("LATTICEAG_CONFIG wins over a discovered file", () => {
    const root = tempDir();
    const cwd = path.join(root, "proj");
    mkdirSync(cwd, { recursive: true });
    writeConfig(
      cwd,
      `${JSON.stringify(createDefaultConfig("discovered", ["axion"]), null, 2)}\n`,
    );
    const overrideDir = path.join(root, "override");
    writeConfig(
      overrideDir,
      `${JSON.stringify(createDefaultConfig("from-env", ["viscompile"]), null, 2)}\n`,
    );
    process.env.LATTICEAG_CONFIG = path.join(overrideDir, "latticeag.json");
    const loaded = loadConfig(cwd);
    expect(loaded.from_env).toBe(true);
    expect(loaded.config.project.name).toBe("from-env");
    expect(loaded.config.adapters.viscompile.enabled).toBe(true);
    expect(loaded.config.adapters.axion.enabled).toBe(false);
  });

  it("strict unknown keys fail load", () => {
    const root = tempDir();
    const config = createDefaultConfig("strict", ["axion"]);
    const raw = { ...config, extra_key: true };
    writeConfig(root, `${JSON.stringify(raw, null, 2)}\n`);
    expect(() => loadConfig(root)).toThrow(ConfigSchemaError);
    try {
      loadConfig(root);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigSchemaError);
      const schemaErr = err as ConfigSchemaError;
      expect(schemaErr.message).toMatch(/extra_key/);
    }
  });

  it("unknown nested keys fail load", () => {
    const root = tempDir();
    const config = createDefaultConfig("nested", ["axion"]);
    const raw = {
      ...config,
      ingest: { ...config.ingest, bind: "0.0.0.0" },
    };
    writeConfig(root, `${JSON.stringify(raw, null, 2)}\n`);
    expect(() => loadConfig(root)).toThrow(ConfigSchemaError);
  });

  it("JSONC fails parse with a byte offset", () => {
    const root = tempDir();
    const body = `{
  "schema_version": 1, // comment
  "project": { "name": "x" }
}
`;
    const filePath = writeConfig(root, body);
    try {
      loadConfig(root);
      expect.fail("expected parse error");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigParseError);
      const parseErr = err as ConfigParseError;
      expect(parseErr.filePath).toBe(filePath);
      expect(parseErr.byteOffset).toBeGreaterThanOrEqual(0);
      expect(parseErr.message).toMatch(/byte offset/);
      expect(parseErr.message).toMatch(/JSONC|invalid JSON/i);
    }
  });

  it("trailing comma fails parse with a byte offset", () => {
    const root = tempDir();
    const body = `{
  "schema_version": 1,
}
`;
    writeConfig(root, body);
    try {
      loadConfig(root);
      expect.fail("expected parse error");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigParseError);
      const parseErr = err as ConfigParseError;
      expect(parseErr.byteOffset).toBeGreaterThanOrEqual(0);
      expect(parseErr.message).toMatch(/byte offset/);
      expect(parseErr.message).toMatch(/trailing comma|invalid JSON/);
    }
  });

  it("createDefaultConfig parses with the zod schema", () => {
    const config = createDefaultConfig("demo", [
      "axion",
      "visreplay",
      "lexverdict",
      "vekinbox",
    ]);
    const again = latticeagConfigSchema.parse(config);
    expect(again.schema_version).toBe(1);
    expect(again.ingest.bind).toBe("127.0.0.1");
    expect(again.ingest.path).toBe("/v1/ingest");
    expect(again.adapters.axion.base_url).toBe("http://127.0.0.1:8787");
    expect(again.adapters.visreplay.session_dir).toBe(".latticeag/sessions");
    expect(again.sync.enabled).toBe(false);
    expect(again.sync.polymesh.enabled).toBe(false);
  });

  it("committed json schema matches zod", () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const schemaPath = path.join(
      repoRoot,
      "schemas",
      "latticeag-config-v1.schema.json",
    );
    const generated = latticeagConfigJsonSchema();
    const committed = JSON.parse(readFileSync(schemaPath, "utf8")) as unknown;
    expect(committed).toEqual(generated);
  });
});
