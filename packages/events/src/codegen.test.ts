import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  GENERATED_PATHS,
  checkArtifacts,
  computeSourceHash,
  generateArtifactMap,
  pkgRoot,
} from "./codegen.js";

describe("codegen", () => {
  test("hashes types.ts+zod.ts against schemas/ and python/", () => {
    const sourceHash = computeSourceHash();
    expect(sourceHash).toMatch(/^[0-9a-f]{64}$/);

    const artifacts = generateArtifactMap();
    const drift = checkArtifacts(artifacts);
    expect(drift).toEqual([]);

    const lockPath = join(pkgRoot, "schemas/codegen-lock.json");
    expect(existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      source: string;
      artifacts: string;
    };
    expect(lock.source).toBe(sourceHash);

    const h = createHash("sha256");
    for (const rel of Object.keys(artifacts).sort()) {
      if (rel === "schemas/codegen-lock.json") {
        continue;
      }
      h.update(rel);
      h.update("\0");
      h.update(readFileSync(join(pkgRoot, rel)));
      h.update("\0");
    }
    expect(lock.artifacts).toBe(h.digest("hex"));

    for (const rel of GENERATED_PATHS) {
      expect(existsSync(join(pkgRoot, rel)), rel).toBe(true);
    }
  });
});
