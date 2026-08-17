import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ConfigError } from "./errors.js";
import { LatticeAG } from "./lattice.js";
import { cleanEnv } from "./test-harness.js";

describe("LatticeAG.create", () => {
  test("missing latticeag.json throws CONFIG_NOT_FOUND", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lg-core-noconfig-"));
    const prev = process.env.LATTICEAG_CONFIG;
    delete process.env.LATTICEAG_CONFIG;
    try {
      await LatticeAG.create({ cwd: dir, env: cleanEnv() });
      expect.fail("expected CONFIG_NOT_FOUND");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("CONFIG_NOT_FOUND");
    } finally {
      if (prev === undefined) {
        delete process.env.LATTICEAG_CONFIG;
      } else {
        process.env.LATTICEAG_CONFIG = prev;
      }
    }
  });

  test("create({ sync: true }) throws SYNC_CLI_ONLY", async () => {
    try {
      await LatticeAG.create({ sync: true, env: cleanEnv() });
      expect.fail("expected SYNC_CLI_ONLY");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe("SYNC_CLI_ONLY");
    }
  });
});
